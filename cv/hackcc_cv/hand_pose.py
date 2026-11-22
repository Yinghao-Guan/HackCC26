"""What shape a tracked hand is making: open palm, fist, pinch, or the drawing "point".

Everything is measured in "hand units" (wrist to middle-finger knuckle = 1), using
distances only, so it works at any distance from the camera and any tilt.

MediaPipe landmark ids: 0 wrist; thumb 1-4; index 5-8; middle 9-12; ring 13-16;
pinky 17-20 (knuckle, middle joint, top joint, tip for each finger).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

WRIST = 0
THUMB_TIP = 4
INDEX_TIP = 8
MIDDLE_MCP = 9
FINGERS = {  # knuckle (MCP), middle joint (PIP), tip
    "index": (5, 6, 8),
    "middle": (9, 10, 12),
    "ring": (13, 14, 16),
    "pinky": (17, 18, 20),
}
KNUCKLES = (5, 9, 13, 17)

PINCH_CLOSE = 0.30  # thumb and index tips closer than this: pinched
PINCH_OPEN = 0.45  # ...and they must open past this to let go (no flicker in between)
EXTENDED = 1.15  # a finger is out if its tip is this much further from the wrist than its middle joint
THUMB_OUT = 0.60  # thumb tip this far from the middle knuckle: thumb spread out

Pose = Literal["open", "fist", "pinch", "point", "other"]


@dataclass(frozen=True)
class Hand:
    """One tracked hand. `label` is "Left" or "Right" (the person's hand)."""

    label: str
    landmarks: np.ndarray  # (21, 2) camera px
    score: float

    def __post_init__(self) -> None:
        if np.shape(self.landmarks) != (21, 2):
            raise ValueError("A hand needs 21 (x, y) landmarks.")


@dataclass(frozen=True)
class HandPose:
    label: str
    pose: Pose
    pinched: bool
    pinch_point: np.ndarray  # between thumb and index tips, camera px
    palm: np.ndarray  # centre of the palm, camera px
    size: float  # wrist to middle knuckle, camera px
    index_tip: np.ndarray  # the drawing fingertip, camera px
    landmarks: np.ndarray  # all 21 points, camera px (for drawing the skeleton)
    gap: float  # thumb tip to index tip, hand units (pinched below PINCH_CLOSE)
    curled: int  # how many of the 4 fingers are curled (4 = fist)
    extended: int  # how many of the 4 fingers are straight


def _distance(points: np.ndarray, a: int, b: int) -> float:
    return float(np.linalg.norm(points[a] - points[b]))


def palm_and_size(landmarks: np.ndarray) -> tuple[np.ndarray, float]:
    """Palm centre (camera px) and hand size (wrist to middle knuckle, px)."""
    points = np.asarray(landmarks, dtype=np.float64)
    size = max(_distance(points, WRIST, MIDDLE_MCP), 1e-6)
    return np.mean(points[[WRIST, *KNUCKLES]], axis=0), size


def classify(hand: Hand, was_pinched: bool = False) -> HandPose:
    """The pose of one hand. Pass `was_pinched` from the previous frame for hysteresis."""
    points = np.asarray(hand.landmarks, dtype=np.float64)
    size = max(_distance(points, WRIST, MIDDLE_MCP), 1e-6)

    extended = {}
    folded = {}
    for name, (_, pip, tip) in FINGERS.items():
        ratio = _distance(points, WRIST, tip) / max(_distance(points, WRIST, pip), 1e-6)
        extended[name] = ratio > EXTENDED
        folded[name] = ratio < 1.0
    thumb_out = _distance(points, THUMB_TIP, MIDDLE_MCP) / size > THUMB_OUT
    gap = _distance(points, THUMB_TIP, INDEX_TIP) / size
    close_enough = gap < (PINCH_OPEN if was_pinched else PINCH_CLOSE)

    pose: Pose
    if all(folded.values()):
        pose = "fist"  # checked first: in a fist the thumb often rests near the index
    elif close_enough and not folded["index"]:
        pose = "pinch"
    elif all(extended.values()) and thumb_out:
        pose = "open"
    elif extended["index"] and not any(extended[f] for f in ("middle", "ring", "pinky")):
        pose = "point"
    else:
        pose = "other"

    return HandPose(
        label=hand.label,
        pose=pose,
        pinched=pose == "pinch",
        pinch_point=(points[THUMB_TIP] + points[INDEX_TIP]) / 2,
        palm=np.mean(points[[WRIST, *KNUCKLES]], axis=0),
        size=size,
        index_tip=points[INDEX_TIP].copy(),
        landmarks=points.copy(),
        gap=gap,
        curled=sum(folded.values()),
        extended=sum(extended.values()),
    )
