"""The current camera-to-board calibration: making it, saving it, and checking it still fits.

A calibration maps camera pixels to board pixels (CSS pixels of the fullscreen
board page). It is only valid for the board page size and camera image size it
was made with; `stale_reason` says when that is no longer true.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np

from .events import Display

log = logging.getLogger(__name__)

Method = Literal["manual", "aruco"]
METHODS = ("manual", "aruco")
LATEST_FILE = "calibration.json"
HISTORY_DIR = "history"
TARGET_INSET = 0.1  # manual targets sit 10% in from each edge of the board page
SIZE_TOLERANCE_PX = 1.0


class CalibrationError(ValueError):
    """A saved calibration is missing parts or damaged."""


@dataclass(frozen=True)
class Calibration:
    camera_to_board: tuple[tuple[float, float, float], ...]
    method: Method
    camera_size: tuple[int, int]
    board_size: tuple[float, float]
    reprojection_error_px: float
    points: int
    created_at: float

    @classmethod
    def from_matrix(
        cls,
        matrix: np.ndarray,
        *,
        method: Method,
        camera_size: tuple[int, int],
        board_size: tuple[float, float],
        reprojection_error_px: float,
        points: int,
    ) -> Calibration:
        rows = tuple(tuple(float(v) for v in row) for row in np.asarray(matrix))
        return cls(
            camera_to_board=rows,  # type: ignore[arg-type]
            method=method,
            camera_size=camera_size,
            board_size=board_size,
            reprojection_error_px=reprojection_error_px,
            points=points,
            created_at=time.time(),
        )

    def matrix(self) -> np.ndarray:
        return np.array(self.camera_to_board, dtype=np.float64)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)

    @classmethod
    def from_json(cls, text: str) -> Calibration:
        try:
            data = json.loads(text)
            return cls._from_dict(data)
        except CalibrationError:
            raise
        except (ValueError, TypeError, KeyError, OverflowError) as error:
            raise CalibrationError(f"The calibration file is damaged: {error}") from error

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> Calibration:
        rows = data["camera_to_board"]
        if len(rows) != 3 or any(len(row) != 3 for row in rows):
            raise CalibrationError("The calibration matrix must be 3x3.")
        matrix = tuple(tuple(float(v) for v in row) for row in rows)
        array = np.array(matrix)
        if not np.all(np.isfinite(array)) or abs(np.linalg.det(array)) < 1e-12:
            raise CalibrationError("The calibration matrix is not usable.")
        if data["method"] not in METHODS:
            raise CalibrationError(f"Unknown calibration method {data['method']!r}.")
        camera_w, camera_h = (int(v) for v in data["camera_size"])
        board_w, board_h = (float(v) for v in data["board_size"])
        created_at = float(data["created_at"])
        if not all(math.isfinite(v) for v in (board_w, board_h, created_at)):
            raise CalibrationError("The calibration has values that are not finite.")
        if min(camera_w, camera_h) <= 0 or min(board_w, board_h) <= 0:
            raise CalibrationError("Calibration sizes must be positive.")
        error = float(data["reprojection_error_px"])
        if not math.isfinite(error) or error < 0:
            raise CalibrationError("The calibration error value is not valid.")
        return cls(
            camera_to_board=matrix,  # type: ignore[arg-type]
            method=data["method"],
            camera_size=(camera_w, camera_h),
            board_size=(board_w, board_h),
            reprojection_error_px=error,
            points=int(data["points"]),
            created_at=created_at,
        )


def manual_targets(display: Display, inset: float = TARGET_INSET) -> list[tuple[float, float]]:
    """Where to draw the 4 numbered targets on the board page, clockwise from top-left."""
    left, right = display.width * inset, display.width * (1 - inset)
    top, bottom = display.height * inset, display.height * (1 - inset)
    return [(left, top), (right, top), (right, bottom), (left, bottom)]


def stale_reason(
    calibration: Calibration, display: Display, camera_size: tuple[int, int] | None
) -> str | None:
    """Why the calibration no longer fits the current setup, or None if it still does."""
    board_w, board_h = calibration.board_size
    if abs(display.width - board_w) > SIZE_TOLERANCE_PX or abs(display.height - board_h) > SIZE_TOLERANCE_PX:
        return (
            f"The board page is {display.width:g}x{display.height:g} now but was "
            f"{board_w:g}x{board_h:g} when calibrated. Recalibrate."
        )
    if camera_size is not None and tuple(camera_size) != tuple(calibration.camera_size):
        cam_w, cam_h = calibration.camera_size
        return (
            f"The camera image is {camera_size[0]}x{camera_size[1]} now but was "
            f"{cam_w}x{cam_h} when calibrated. Recalibrate."
        )
    return None


Status = Literal["none", "ok", "stale", "error"]


def calibration_status_event(
    status: Status, calibration: Calibration | None = None, message: str = ""
) -> dict[str, Any]:
    """Tell the pages whether touch positions can be trusted right now."""
    event: dict[str, Any] = {"type": "calibration", "status": status, "message": message}
    if calibration is not None:
        event.update(
            method=calibration.method,
            reproj_error_px=round(calibration.reprojection_error_px, 3),
            points=calibration.points,
            camera_size=list(calibration.camera_size),
            board_size=list(calibration.board_size),
            created_at=calibration.created_at,
        )
    return event


def save_calibration(calibration: Calibration, data_dir: Path) -> Path:
    """Write the calibration as the current one, plus a timestamped copy to restore later."""
    history = data_dir / HISTORY_DIR
    history.mkdir(parents=True, exist_ok=True)
    text = calibration.to_json()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(calibration.created_at))
    unique = uuid.uuid4().hex[:8]  # two saves in the same second must not overwrite each other
    history_file = history / f"calibration-{stamp}-{calibration.method}-{unique}.json"
    history_file.write_text(text, encoding="utf-8")

    latest = data_dir / LATEST_FILE
    temporary = latest.with_name(f"{LATEST_FILE}.{unique}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(latest)  # atomic: a crash never leaves half a file
    return latest


def load_calibration(data_dir: Path) -> Calibration | None:
    """The saved calibration, or None if there is none. Raises CalibrationError if damaged."""
    path = data_dir / LATEST_FILE
    if not path.exists():
        return None
    return Calibration.from_json(path.read_text(encoding="utf-8"))


class CalibrationStore:
    """Holds the calibration in use. Safe to read from the camera thread."""

    def __init__(self, on_change: Callable[[Calibration], None] | None = None) -> None:
        self._lock = threading.Lock()
        self._current: Calibration | None = None
        self._on_change = on_change

    def current(self) -> Calibration | None:
        with self._lock:
            return self._current

    def set(self, calibration: Calibration) -> None:
        with self._lock:
            self._current = calibration
        if self._on_change is not None:
            self._on_change(calibration)
