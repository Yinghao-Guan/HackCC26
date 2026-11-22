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


@dataclass(frozen=True)
class Hello:
    display: Display


@dataclass(frozen=True)
class Ping:
    pass


ClientMessage = Hello | Ping


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
        return Hello(
            Display(
                width=_number(body, "width", 1, MAX_DISPLAY_SIDE),
                height=_number(body, "height", 1, MAX_DISPLAY_SIDE),
                dpr=_number(body, "dpr", 0.25, 8, default=1.0),
            )
        )
    if kind == "ping":
        return Ping()
    raise MessageError(f"Unknown message type {kind!r}.")
