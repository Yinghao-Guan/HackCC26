"""List the cameras this computer can open, to pick CV_CAMERA_INDEX.

Run:  uv run python -m hackcc_cv.probe
Close any app using the camera first (Teams, Zoom, the CV server itself).
"""

from __future__ import annotations

import logging
import time

import cv2

from .camera import BACKEND_IDS

log = logging.getLogger(__name__)
MAX_INDEX = 5
SAMPLE_SECONDS = 1.0


def probe(index: int, backend: str) -> str | None:  # pragma: no cover - needs hardware
    capture = cv2.VideoCapture(index, BACKEND_IDS[backend])
    try:
        if not capture.isOpened():
            return None
        capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter.fourcc(*"MJPG"))
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        for _ in range(5):
            capture.read()
        frames, start, image = 0, time.monotonic(), None
        while time.monotonic() - start < SAMPLE_SECONDS:
            ok, image = capture.read()
            frames += int(ok)
        if image is None:
            return "opens, but sends no frames"
        fps = frames / (time.monotonic() - start)
        height, width = image.shape[:2]
        return f"{width}x{height} at {fps:.0f} fps, brightness {image.mean():.0f}/255"
    finally:
        capture.release()


def main() -> None:  # pragma: no cover - needs hardware
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for index in range(MAX_INDEX):
        for backend in ("dshow", "msmf"):
            result = probe(index, backend)
            if result is not None:
                log.info("camera %d (%s): %s", index, backend, result)
    log.info("Use the index with: uv run python -m hackcc_cv --camera N")


if __name__ == "__main__":  # pragma: no cover
    main()
