"""Messages on the event bus, in both directions.

Server to browser messages are plain dicts (they go straight to JSON). Browser
to server messages are checked and turned into small immutable objects.

Every position is in board pixels: CSS pixels of the fullscreen board page in
the browser (see docs/02-technical-design.md, section 9).
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any, Literal

MAX_MESSAGE_CHARS = 64_000
MAX_DISPLAY_SIDE = 16_384

CameraStatus = Literal["ok", "error", "off", "starting"]
_CAMERA_STATUSES = ("ok", "error", "off", "starting")


@dataclass(frozen=True)
class Display:
    """The browser's board page: its size in CSS pixels and its device pixel ratio."""

    width: float
    height: float
    dpr: float = 1.0


DEFAULT_DISPLAY = Display(1280, 720, 1.0)


Role = Literal["board", "operator"]
ROLES = ("board", "operator")


@dataclass(frozen=True)
class Hello:
    """A page joined. Only the "board" page (the one on the projector) sets the board size."""

    display: Display
    role: Role = "board"


@dataclass(frozen=True)
class Ping:
    pass


@dataclass(frozen=True)
class StartManualCalibration:
    """Show the 4 numbered targets on the board."""


@dataclass(frozen=True)
class ManualCalibration:
    """The operator clicked the 4 targets in the camera image, in order 1 to 4."""

    camera_points: tuple[tuple[float, float], ...]
    camera_size: tuple[int, int]


@dataclass(frozen=True)
class CancelCalibration:
    """Hide the targets without changing the calibration."""


@dataclass(frozen=True)
class MapPoint:
    """Show where a camera pixel lands on the board (to check the calibration by eye)."""

    camera_point: tuple[float, float]


@dataclass(frozen=True)
class CalibrateAuto:
    """Show the ArUco grid on the board and calibrate from it automatically."""


@dataclass(frozen=True)
class PatternShown:
    """The board page has drawn the ArUco grid (sent after it is on screen)."""

    run: int | None = None


@dataclass(frozen=True)
class ReadBoard:
    """Read the physical writing in `bbox` (board px), or on the whole board if None."""

    bbox: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class FlashShown:
    """The board page shows the white area for read number `run`."""

    run: int | None = None


ClientMessage = (
    Hello
    | Ping
    | StartManualCalibration
    | ManualCalibration
    | CancelCalibration
    | MapPoint
    | CalibrateAuto
    | PatternShown
    | ReadBoard
    | FlashShown
)


class MessageError(ValueError):
    """A message from the browser could not be understood."""


# ---------------------------------------------------------------------------
# Server to browser
# ---------------------------------------------------------------------------


def pointer_event(
    x: float, y: float, touching: bool, *, pointer_id: int = 0, t: float | None = None
) -> dict[str, Any]:
    return {
        "type": "pointer",
        "id": pointer_id,
        "x": x,
        "y": y,
        "touching": touching,
        "t": time.time() if t is None else t,
    }


def camera_status_event(
    status: str, *, message: str = "", details: dict[str, Any] | None = None
) -> dict[str, Any]:
    if status not in _CAMERA_STATUSES:
        raise ValueError(f"Unknown camera status {status!r}.")
    return {"type": "camera", "status": status, "message": message, **(details or {})}


def hello_ack_event(display: Display) -> dict[str, Any]:
    return {
        "type": "hello_ack",
        "display": {"width": display.width, "height": display.height, "dpr": display.dpr},
    }


def pong_event() -> dict[str, Any]:
    return {"type": "pong", "t": time.time()}


def error_event(message: str) -> dict[str, Any]:
    return {"type": "error", "message": message}


def calibration_targets_event(targets: list[tuple[float, float]]) -> dict[str, Any]:
    """Targets for the board page to draw, numbered from 1. An empty list hides them."""
    return {
        "type": "calibration_targets",
        "targets": [{"id": i, "x": x, "y": y} for i, (x, y) in enumerate(targets, start=1)],
    }


def calibration_probe_event(
    board_point: tuple[float, float], camera_point: tuple[float, float]
) -> dict[str, Any]:
    """A cross for the board page to draw where a clicked camera pixel lands."""
    return {
        "type": "calibration_probe",
        "x": board_point[0],
        "y": board_point[1],
        "camera_x": camera_point[0],
        "camera_y": camera_point[1],
    }


# ---------------------------------------------------------------------------
# Browser to server
# ---------------------------------------------------------------------------


def _number(body: dict[str, Any], key: str, low: float, high: float, default: float | None = None) -> float:
    value = body.get(key, default)
    # bool is a subclass of int in Python; a JSON true is not a size.
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise MessageError(f"'{key}' must be a number.")
    if not low <= value <= high:
        raise MessageError(f"'{key}' must be between {low} and {high}.")
    return value


def _pair(value: Any, name: str, low: float, high: float) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise MessageError(f"'{name}' must be a pair of numbers.")
    wrapped = {"a": value[0], "b": value[1]}
    return (_number(wrapped, "a", low, high), _number(wrapped, "b", low, high))


def _manual_calibration(body: dict[str, Any]) -> ManualCalibration:
    points = body.get("camera_points")
    if not isinstance(points, list) or len(points) != 4:
        raise MessageError("'camera_points' must be a list of 4 points.")
    camera_points = tuple(_pair(p, "camera_points", -MAX_DISPLAY_SIDE, MAX_DISPLAY_SIDE) for p in points)
    width, height = _pair(body.get("camera_size"), "camera_size", 1, MAX_DISPLAY_SIDE)
    return ManualCalibration(camera_points, (int(width), int(height)))


def _read_board(body: dict[str, Any]) -> ReadBoard:
    raw = body.get("bbox")
    if raw is None:
        return ReadBoard()
    if not isinstance(raw, list) or len(raw) != 4:
        raise MessageError("'bbox' must be [x, y, width, height].")
    wrapped = dict(zip("xywh", raw))
    x = _number(wrapped, "x", -MAX_DISPLAY_SIDE, MAX_DISPLAY_SIDE)
    y = _number(wrapped, "y", -MAX_DISPLAY_SIDE, MAX_DISPLAY_SIDE)
    try:
        w = _number(wrapped, "w", 1, MAX_DISPLAY_SIDE)
        h = _number(wrapped, "h", 1, MAX_DISPLAY_SIDE)
    except MessageError as error:
        raise MessageError("'bbox' width and height must be positive.") from error
    return ReadBoard((x, y, w, h))


def parse_client_message(raw: str) -> ClientMessage:
    """Check a text message from the browser. Raises MessageError if it is not usable."""
    if len(raw) > MAX_MESSAGE_CHARS:
        raise MessageError("Message is too long.")
    try:
        body = json.loads(raw)
    except json.JSONDecodeError as error:
        raise MessageError("Message must be JSON.") from error
    if not isinstance(body, dict) or not isinstance(body.get("type"), str):
        raise MessageError("Message must be an object with a 'type'.")

    kind = body["type"]
    if kind == "hello":
        role = body.get("role", "board")
        if role not in ROLES:
            raise MessageError(f"'role' must be one of {', '.join(ROLES)}.")
        return Hello(
            Display(
                width=_number(body, "width", 1, MAX_DISPLAY_SIDE),
                height=_number(body, "height", 1, MAX_DISPLAY_SIDE),
                dpr=_number(body, "dpr", 0.25, 8, default=1.0),
            ),
            role,
        )
    if kind == "ping":
        return Ping()
    if kind == "calibrate_manual_start":
        return StartManualCalibration()
    if kind == "calibrate_manual":
        return _manual_calibration(body)
    if kind == "calibrate_cancel":
        return CancelCalibration()
    if kind == "calibrate_auto":
        return CalibrateAuto()
    if kind == "calibration_pattern_shown":
        run = body.get("run")
        if run is not None and (isinstance(run, bool) or not isinstance(run, int)):
            raise MessageError("'run' must be a whole number.")
        return PatternShown(run)
    if kind == "read_board":
        return _read_board(body)
    if kind == "flash_shown":
        run = body.get("run")
        if run is not None and (isinstance(run, bool) or not isinstance(run, int)):
            raise MessageError("'run' must be a whole number.")
        return FlashShown(run)
    if kind == "map_point":
        point = _pair(body.get("camera_point"), "camera_point", -MAX_DISPLAY_SIDE, MAX_DISPLAY_SIDE)
        return MapPoint(point)
    raise MessageError(f"Unknown message type {kind!r}.")
