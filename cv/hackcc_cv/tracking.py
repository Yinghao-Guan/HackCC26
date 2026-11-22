"""The hand-tracking loop: camera frame -> MediaPipe hands -> gestures -> event bus.

Runs in its own thread so the slow part (about 20 ms per frame) never blocks the server.
It is the single hand-tracking stream (docs/02, design principle 2): other parts, such as
touch detection, should reuse its results instead of running MediaPipe again.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

import numpy as np

from .camera import Frame
from .gestures import GestureEngine
from .hand_pose import Hand, HandPose
from .homography import map_points

log = logging.getLogger(__name__)

HANDS_EVENT_HZ = 15  # how often the "hands" stream (for the Gesture Lab page) is sent
IDLE_WAIT_S = 0.005
STOP_TIMEOUT_S = 3.0
FPS_SMOOTHING = 0.1
MAX_FAILURES_IN_A_ROW = 30  # about one second of bad frames


class FrameSource(Protocol):
    def latest(self) -> Frame | None: ...


class Tracker(Protocol):
    def detect(self, image_bgr: np.ndarray, timestamp_ms: int) -> list[Hand]: ...
    def close(self) -> None: ...


class CalibrationLike(Protocol):
    def matrix(self) -> np.ndarray: ...


Publish = Callable[[dict[str, Any]], None]


class TrackingLoop:
    def __init__(
        self,
        camera: FrameSource,
        make_tracker: Callable[[], Tracker],
        publish: Publish,
        current_calibration: Callable[[], CalibrationLike | None],
        touching: Callable[[], bool] = lambda: False,
    ) -> None:
        self._camera = camera
        self._make_tracker = make_tracker
        self._publish = publish
        self._calibration = current_calibration
        # Role A's touch detection plugs in here; until then nothing counts as touching.
        self._touching = touching
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._status = "off"
        self._message = ""
        self._fps = 0.0
        self._frame_width = 0  # camera image width, for the mirror view before calibration

    def start(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="hand-tracking", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=STOP_TIMEOUT_S)
            self._thread = None
        self._status = "off"

    def status(self) -> dict[str, Any]:
        return {"status": self._status, "message": self._message, "fps": round(self._fps, 1)}

    # -- internals --------------------------------------------------------------

    def _set_status(self, status: str, message: str = "") -> None:
        self._status, self._message = status, message
        self._publish({"type": "tracking", **self.status()})

    def _to_board(self, points: np.ndarray) -> np.ndarray:
        """Camera px to board px through the calibration.

        Before calibration, a mirror view: a camera facing the person sees their right as
        its left, so x is flipped to make moving a hand right move things right.
        After calibration the board itself sets the direction, so no flip.
        """
        calibration = self._calibration()
        if calibration is not None:
            return map_points(calibration.matrix(), points)
        mirrored = np.array(points, dtype=np.float64)
        mirrored[..., 0] = self._frame_width - mirrored[..., 0]
        return mirrored

    def _run(self) -> None:
        try:
            tracker = self._make_tracker()
        except Exception as error:  # a broken model must not take the server down
            log.exception("Could not start hand tracking")
            self._set_status("error", f"Hand tracking could not start: {error}")
            return
        self._set_status("ok")
        try:
            self._loop(tracker)
        except Exception as error:
            log.exception("Hand tracking crashed")
            self._set_status("error", f"Hand tracking stopped: {error}")
        finally:
            tracker.close()

    def _loop(self, tracker: Tracker) -> None:
        engine = GestureEngine(to_board=self._to_board)
        last_index, last_frame_at, last_hands_at = -1, time.monotonic(), 0.0
        had_hands, failures = False, 0
        while not self._stop.is_set():
            frame = self._camera.latest()
            if frame is None or frame.index == last_index:
                self._stop.wait(IDLE_WAIT_S)
                continue
            last_index = frame.index
            self._frame_width = int(frame.image.shape[1])
            try:
                hands = tracker.detect(frame.image, int(time.monotonic() * 1000))
                # The engine times gestures on a steady clock; pages get wall-clock times.
                events = engine.update(hands, time.monotonic(), touching=self._touching())
            except Exception as error:  # noqa: BLE001 - one bad frame must not end tracking
                failures += 1
                log.warning("Hand tracking skipped a frame: %s", error)
                if failures == MAX_FAILURES_IN_A_ROW:
                    self._set_status("error", f"Hand tracking keeps failing: {error}")
                continue
            if failures >= MAX_FAILURES_IN_A_ROW:
                self._set_status("ok")
            failures = 0
            wall = time.time()
            for event in events:
                self._publish({**event, "t": wall})

            now = time.monotonic()
            elapsed, last_frame_at = now - last_frame_at, now
            if elapsed > 0:
                instant = 1.0 / elapsed
                self._fps = instant if self._fps == 0 else self._fps + FPS_SMOOTHING * (instant - self._fps)
            if (hands and now - last_hands_at >= 1 / HANDS_EVENT_HZ) or (had_hands and not hands):
                self._publish(self._hands_event(engine.last_poses))
                last_hands_at = now
            had_hands = bool(hands)

    def _hands_event(self, poses: dict[str, HandPose]) -> dict[str, Any]:
        """Where each hand is and what shape the engine sees, in board px (for debug views)."""
        listed = []
        for key, pose in poses.items():
            points = self._to_board(np.array([pose.palm, pose.index_tip, pose.pinch_point]))
            if not np.all(np.isfinite(points)):
                continue
            (px, py), (tx, ty), (cx, cy) = points.tolist()
            listed.append({
                "hand": key,
                "pose": pose.pose,
                "palm": [round(px, 1), round(py, 1)],
                "index_tip": [round(tx, 1), round(ty, 1)],
                "pinch": [round(cx, 1), round(cy, 1)],
                # Camera px skeleton and the measurements behind the pose, for tuning.
                "camera_points": np.round(pose.landmarks, 1).tolist(),
                "gap": round(pose.gap, 3),
                "curled": pose.curled,
                "extended": pose.extended,
            })
        return {"type": "hands", "hands": listed, "calibrated": self._calibration() is not None}
