"""Synthetic MediaPipe-style hand landmarks (21 points, camera px) for each pose.

Coordinates are in "hand units" (wrist to middle-finger knuckle = 1), drawn upright
with the palm to the camera, then scaled, rotated and moved into the camera image.
"""

from __future__ import annotations

import math

import numpy as np

from hackcc_cv.hand_pose import Hand

KNUCKLES = {  # index, middle, ring, pinky MCPs
    "index": (-0.30, -0.95),
    "middle": (-0.05, -1.00),
    "ring": (0.18, -0.95),
    "pinky": (0.38, -0.85),
}
LENGTH = {"index": 1.0, "middle": 1.05, "ring": 0.95, "pinky": 0.75}


def _finger(name: str, extended: bool) -> list[tuple[float, float]]:
    mx, my = KNUCKLES[name]
    k = LENGTH[name]
    if extended:
        steps = [(0, -0.45 * k), (0, -0.75 * k), (0, -1.0 * k)]
    else:  # curled back towards the palm
        steps = [(0, -0.30 * k), (0, -0.10 * k), (0, 0.15 * k)]
    return [(mx, my)] + [(mx + dx, my + dy) for dx, dy in steps]


def _thumb(tip: tuple[float, float]) -> list[tuple[float, float]]:
    return [(-0.25, -0.20), (-0.45, -0.40), (-0.60, -0.60), tip]


THUMB_OUT = (-0.75, -0.80)
THUMB_ACROSS = (-0.20, -0.60)


def hand_units(pose: str) -> np.ndarray:
    """21 points in hand units for: open, fist, point, pinch, pinch_open_fingers."""
    if pose == "open":
        thumb, fingers = THUMB_OUT, dict.fromkeys(KNUCKLES, True)
    elif pose == "fist":
        thumb, fingers = THUMB_ACROSS, dict.fromkeys(KNUCKLES, False)
    elif pose == "point":  # the drawing hand: index out, the rest curled
        thumb, fingers = THUMB_ACROSS, {"index": True, "middle": False, "ring": False, "pinky": False}
    elif pose in ("pinch", "pinch_open_fingers"):
        others = pose == "pinch_open_fingers"
        points = [(0.0, 0.0)] + _thumb((-0.50, -1.58))
        points += [KNUCKLES["index"], (-0.30, -1.35), (-0.38, -1.55), (-0.48, -1.62)]
        for name in ("middle", "ring", "pinky"):
            points += _finger(name, others)
        return np.array(points, dtype=np.float64)
    else:
        raise ValueError(pose)
    points = [(0.0, 0.0)] + _thumb(thumb)
    for name in ("index", "middle", "ring", "pinky"):
        points += _finger(name, fingers[name])
    return np.array(points, dtype=np.float64)


def make_hand(
    pose: str,
    at: tuple[float, float] = (640, 500),
    size: float = 120.0,
    angle_deg: float = 0.0,
    label: str = "Right",
) -> Hand:
    """A hand in the camera image: wrist at `at`, `size` px from wrist to middle knuckle."""
    a = math.radians(angle_deg)
    rotation = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    points = hand_units(pose) @ rotation.T * size + np.array(at, dtype=np.float64)
    return Hand(label=label, landmarks=points, score=0.95)
