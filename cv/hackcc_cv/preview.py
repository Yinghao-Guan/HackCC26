"""Turning camera frames into something a person can look at."""

from __future__ import annotations

import cv2
import numpy as np


def annotate(image: np.ndarray, fps: float, label: str = "") -> np.ndarray:
    """A copy of the frame with the frame rate (and a label) written in the corner."""
    out = image.copy()
    text = f"{label}  {fps:.1f} fps".strip()
    # Dark outline under light text, so it reads on any background.
    for color, thickness in (((0, 0, 0), 4), ((255, 255, 255), 1)):
        cv2.putText(out, text, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, thickness, cv2.LINE_AA)
    return out


def encode_jpeg(image: np.ndarray, quality: int = 80) -> bytes:
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Could not encode the frame as JPEG.")
    return buffer.tobytes()
