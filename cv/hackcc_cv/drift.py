"""Noticing that the camera moved (docs/02-technical-design.md, section 10).

Printed ArUco markers (ids 40-47) stuck around the board, outside the projection,
never move. Their positions in the camera image are recorded at calibration time. If
most of them later appear somewhere else, the camera (or board) moved and the
calibration no longer fits: wait until the camera is still again, then recalibrate.

Robust by design: the median over markers ignores one misread or covered marker, a
move must be seen several checks in a row (not a hand passing), and recalibration
waits until the markers stop moving.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from .markers import STATIC_MARKER_IDS

MOVE_PX = 4.0  # median marker shift (camera px) that counts as a move
STILL_PX = 1.5  # between checks, markers moving less than this means the camera is still
MIN_MARKERS = 2
CONFIRM_CHECKS = 3  # a shift must be seen this many checks in a row
SETTLE_CHECKS = 4  # ...then the camera must stay still this many checks before recalibrating

Status = Literal["off", "unknown", "steady", "checking", "moved", "recalibrate"]


@dataclass(frozen=True)
class StaticMarker:
    """A printed marker: id, centre (camera px) and side length (camera px)."""

    id: int
    x: float
    y: float
    size: float


@dataclass(frozen=True)
class DriftVerdict:
    status: Status
    shift_px: float  # median shift from the calibration positions
    seen: int  # printed markers matched this check


def static_markers_in(found: dict[int, np.ndarray]) -> list[StaticMarker]:
    """The printed (static) markers among detected ones, with centre and size."""
    markers = []
    for marker_id in sorted(i for i in found if i in STATIC_MARKER_IDS):
        corners = np.asarray(found[marker_id], dtype=np.float64).reshape(4, 2)
        centre = corners.mean(axis=0)
        size = float(np.mean(np.linalg.norm(np.roll(corners, -1, axis=0) - corners, axis=1)))
        markers.append(StaticMarker(marker_id, round(float(centre[0]), 2), round(float(centre[1]), 2), round(size, 2)))
    return markers


def _median_shift(a: list[StaticMarker], b: list[StaticMarker]) -> tuple[float, int]:
    """Typical shift of the markers in both lists, ignoring one odd marker.

    With 3 or more the median ignores one misread or half-covered marker; with exactly 2
    the median would be their average, so use the smaller: both must have moved.
    """
    by_id = {m.id: m for m in b}
    shifts = [float(np.hypot(m.x - by_id[m.id].x, m.y - by_id[m.id].y)) for m in a if m.id in by_id]
    if not shifts:
        return 0.0, 0
    typical = min(shifts) if len(shifts) == 2 else float(np.median(shifts))
    return typical, len(shifts)


class DriftMonitor:
    """Decides, check by check, whether the printed markers say the camera moved."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._moved_checks = 0
        self._still_checks = 0
        self._previous: list[StaticMarker] = []

    def update(self, baseline: list[StaticMarker], found: list[StaticMarker]) -> DriftVerdict:
        if not baseline:
            self.reset()
            return DriftVerdict("off", 0.0, 0)
        shift, seen = _median_shift(found, baseline)
        if seen < MIN_MARKERS:
            return DriftVerdict("unknown", shift, seen)  # can't tell; don't count either way
        if shift <= MOVE_PX:
            self.reset()
            return DriftVerdict("steady", round(shift, 2), seen)

        self._moved_checks += 1
        if self._moved_checks < CONFIRM_CHECKS:
            self._previous = found
            return DriftVerdict("checking", round(shift, 2), seen)
        motion, _ = _median_shift(found, self._previous) if self._previous else (float("inf"), 0)
        self._previous = found
        self._still_checks = self._still_checks + 1 if motion <= STILL_PX else 0
        status: Status = "recalibrate" if self._still_checks >= SETTLE_CHECKS else "moved"
        return DriftVerdict(status, round(shift, 2), seen)
