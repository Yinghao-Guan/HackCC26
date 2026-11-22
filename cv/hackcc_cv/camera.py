"""The one place that owns the camera.

Windows lets only one program open a webcam at a time, so every part of the CV
service (calibration, hand tracking, reading the board) reads frames from here
instead of opening the camera itself.

Threading: the camera thread alone uses the capture object, from opening (or
reopening) to releasing it. Other threads only read `latest()` and `status()`
and ask it to stop.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

from .config import Config

log = logging.getLogger(__name__)

BACKEND_IDS = {"dshow": cv2.CAP_DSHOW, "msmf": cv2.CAP_MSMF, "any": cv2.CAP_ANY}
MAX_READ_FAILURES = 10  # in a row, before we close and reopen the camera
REOPEN_DELAY_SECONDS = 0.2
RETRY_OPEN_SECONDS = 1.0
STOP_TIMEOUT_SECONDS = 3.0
FPS_SMOOTHING = 0.1


class CameraError(RuntimeError):
    """The camera could not be opened or stopped working."""


@dataclass(frozen=True)
class Frame:
    """One camera image. Treat `image` as read-only: other threads share it."""

    image: np.ndarray
    index: int
    timestamp: float


CaptureFactory = Callable[[int, int], Any]
StatusListener = Callable[[dict[str, Any]], None]


class Camera:
    def __init__(
        self,
        config: Config,
        capture_factory: CaptureFactory = cv2.VideoCapture,
        on_status: StatusListener | None = None,
    ) -> None:
        self._config = config
        self._factory = capture_factory
        self._on_status = on_status
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._frame_lock = threading.Lock()
        self._status_lock = threading.Lock()
        self._latest: Frame | None = None
        self._fps = 0.0
        self._status = "off"
        self._message = ""
        self._size = (0, 0)

    # -- public ---------------------------------------------------------------

    def start(self) -> None:
        """Open the camera and start reading frames. Raises CameraError if it can't open."""
        self._stop.clear()
        capture = self._open()
        self._thread = threading.Thread(target=self._run, args=(capture,), name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Ask the camera thread to finish; it releases the camera itself."""
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=STOP_TIMEOUT_SECONDS)
            if thread.is_alive():
                log.warning("The camera thread did not stop in time; the camera may stay busy.")
                self._set_status("error", "The camera did not stop cleanly.")
                return
        self._set_status("off", "")

    def latest(self) -> Frame | None:
        with self._frame_lock:
            return self._latest

    @property
    def fps(self) -> float:
        return self._fps

    def status(self) -> dict[str, Any]:
        width, height = self._size
        return {
            "status": self._status,
            "message": self._message,
            "index": self._config.camera_index,
            "backend": self._config.camera_backend,
            "width": width,
            "height": height,
            "fps": round(self._fps, 1),
        }

    # -- internals ------------------------------------------------------------

    def _open(self) -> Any:
        """Open and set up the camera. Raises CameraError (never anything else)."""
        cfg = self._config
        failure = (
            f"Could not open camera {cfg.camera_index} ({cfg.camera_backend}). "
            "Is another app using it? List cameras with: uv run python -m hackcc_cv.probe"
        )
        capture = None
        try:
            capture = self._factory(cfg.camera_index, BACKEND_IDS[cfg.camera_backend])
            if not capture.isOpened():
                raise CameraError(failure)

            # MJPG lets USB cameras deliver 720p/1080p at full frame rate.
            capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter.fourcc(*"MJPG"))
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, cfg.width)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, cfg.height)
            capture.set(cv2.CAP_PROP_FPS, cfg.fps)

            # Throw away the first frames while exposure settles (some drivers start black).
            deadline = time.monotonic() + cfg.warmup_seconds
            while time.monotonic() < deadline and not self._stop.is_set():
                capture.read()
        except Exception as error:
            if capture is not None:
                capture.release()
            message = failure if isinstance(error, CameraError) else f"{failure} ({error})"
            self._set_status("error", message)
            raise CameraError(message) from error

        self._set_status("ok", "")
        return capture

    def _try_open(self) -> Any:
        """Open the camera again after it failed, or return None to retry later."""
        try:
            return self._open()
        except CameraError:
            self._stop.wait(RETRY_OPEN_SECONDS)
            return None

    def _set_status(self, status: str, message: str) -> None:
        with self._status_lock:
            changed = (status, message) != (self._status, self._message)
            self._status, self._message = status, message
            snapshot = self.status() if changed else None
        if snapshot is not None and self._on_status is not None:
            try:
                self._on_status(snapshot)
            except Exception:  # a listener must never kill the camera thread
                log.exception("Camera status listener failed")

    def _store(self, image: np.ndarray, index: int, elapsed: float) -> None:
        if elapsed > 0:
            instant = 1.0 / elapsed
            self._fps = instant if self._fps == 0 else self._fps + FPS_SMOOTHING * (instant - self._fps)
        self._size = (int(image.shape[1]), int(image.shape[0]))
        with self._frame_lock:
            self._latest = Frame(image=image, index=index, timestamp=time.time())

    def _run(self, capture: Any) -> None:
        failures = 0
        index = 0
        last = time.monotonic()
        try:
            while not self._stop.is_set():
                if capture is None:
                    capture = self._try_open()
                    continue
                ok, image = capture.read()
                if not ok or image is None:
                    failures += 1
                    if failures >= MAX_READ_FAILURES:
                        log.warning("Camera stopped delivering frames; reopening it.")
                        self._set_status("error", "The camera stopped sending frames.")
                        capture.release()
                        capture = None
                        failures = 0
                        self._stop.wait(REOPEN_DELAY_SECONDS)
                    continue

                failures = 0
                index += 1
                now = time.monotonic()
                self._store(image, index, now - last)
                last = now
                if self._status != "ok":
                    self._set_status("ok", "")
        except Exception as error:
            log.exception("The camera thread crashed")
            self._set_status("error", f"The camera thread crashed: {error}")
        finally:
            if capture is not None:
                capture.release()
