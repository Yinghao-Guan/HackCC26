"""Reading physical writing on the board, on request (docs/02, section 6).

Flow: show plain white over the area (the board page confirms), wait for the image to
settle, take the median of a few frames, remove the white, straighten the area with the
calibration, find the writing, then publish where it is (so the UI keeps clear of it) and
the straightened picture (for the AI to read).
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

import numpy as np

from .auto_calibration import collect_frames, wait_for_camera_size
from .camera import Camera
from .content import (
    Box,
    ContentError,
    find_writing,
    median_image,
    png_data_url,
    read_region,
)

if TYPE_CHECKING:
    from .state import ServerState

log = logging.getLogger(__name__)

FRAMES = 5
ACK_TIMEOUT_SECONDS = 3.0
SETTLE_SECONDS = 0.4
FRAME_TIMEOUT_SECONDS = 3.0
FLASH_MARGIN_PX = 20.0  # the white reaches this far past the area (calibration slack)
MIN_AREA_SIDE_PX = 10.0


# -- events -----------------------------------------------------------------------------


def flash_event(run: int | None, box: Box | None, color: str = "white") -> dict[str, Any]:
    """Board pages cover `box` (board px) with plain `color`; `bbox: null` removes it."""
    return {"type": "flash", "run": run, "color": color, "bbox": None if box is None else list(box)}


def read_status_event(status: str, message: str = "") -> dict[str, Any]:
    return {"type": "board_read", "status": status, "message": message}


def regions_payload(regions: list[Box]) -> list[dict[str, Any]]:
    return [
        {"id": f"r{i}", "kind": "physical", "bbox": list(box)} for i, box in enumerate(regions, start=1)
    ]


# -- the flow ---------------------------------------------------------------------------


def _analyse(images: list[np.ndarray], matrix: np.ndarray, box: Box) -> tuple[list[Box], str]:
    """Runs in a thread: image work is CPU heavy."""
    crop, scale = read_region(median_image(images), matrix, box)
    return find_writing(crop, scale, box), png_data_url(crop)


def _whole_board(state: ServerState) -> Box:
    return (0.0, 0.0, float(state.display.width), float(state.display.height))


def _clip(box: Box, board: Box, margin: float = 0.0) -> Box | None:
    """`box` grown by `margin` and cut to the board, or None if too little is left."""
    x0 = max(board[0], box[0] - margin)
    y0 = max(board[1], box[1] - margin)
    x1 = min(board[0] + board[2], box[0] + box[2] + margin)
    y1 = min(board[1] + board[3], box[1] + box[3] + margin)
    if x1 - x0 < MIN_AREA_SIDE_PX or y1 - y0 < MIN_AREA_SIDE_PX:
        return None
    return (x0, y0, x1 - x0, y1 - y0)


async def _fail(state: ServerState, reason: str) -> None:
    await state.bus.broadcast(read_status_event("error", reason))


async def run_board_read(state: ServerState, box: Box | None) -> None:
    """The whole read. Shares the calibration lock: both use the projector."""
    async with state.calibration_lock:
        shown = False
        try:
            shown = await _read(state, box)
        except asyncio.CancelledError:
            await asyncio.shield(state.bus.broadcast(flash_event(None, None)))
            await asyncio.shield(state.bus.broadcast(read_status_event("error", "Cancelled.")))
            raise
        except Exception:
            log.exception("Reading the board failed unexpectedly")
            await _fail(state, "Reading the board failed unexpectedly. Check the CV service log.")
            shown = True
        if shown:
            await state.bus.broadcast(flash_event(None, None))


async def _read(state: ServerState, box: Box | None) -> bool:
    """Returns True if the white flash was shown (and so must be removed)."""
    # Right after start-up the camera has no size yet; wait for its first frame.
    camera_size = await wait_for_camera_size(state)
    status = state.calibration_event()
    current = state.calibration.current()
    if current is None or status["status"] != "ok":
        await _fail(state, f"Calibrate first: {status['message'] or 'the calibration is ' + status['status']}")
        return False
    camera: Camera | None = state.camera
    if camera is None or camera_size is None:
        await _fail(state, "The camera is not running, so the board can't be seen.")
        return False

    board = _whole_board(state)
    area = _clip(box, board) if box is not None else board
    if area is None:
        await _fail(state, "That area is outside the board.")
        return False
    white = _clip(area, board, FLASH_MARGIN_PX) or area
    await state.bus.broadcast(read_status_event("reading", "Showing white on the board…"))
    state.flash_run += 1
    state.flash_shown.clear()
    await state.bus.broadcast(flash_event(state.flash_run, white))
    try:
        await asyncio.wait_for(state.flash_shown.wait(), ACK_TIMEOUT_SECONDS)
    except TimeoutError:
        await state.bus.broadcast(flash_event(None, None))  # remove the white, then explain
        await _fail(state, "No board page showed the white area. Open the board page fullscreen, then try again.")
        return False
    await asyncio.sleep(SETTLE_SECONDS)

    await state.bus.broadcast(read_status_event("reading", "Taking the picture…"))
    images = await asyncio.to_thread(collect_frames, camera, FRAMES, FRAME_TIMEOUT_SECONDS)
    await state.bus.broadcast(flash_event(None, None))  # the board can show its content again
    try:
        regions, picture = await asyncio.to_thread(_analyse, images, current.matrix(), area)
    except ContentError as error:
        await _fail(state, str(error))
        return False

    payload = regions_payload(regions)
    state.content_regions = payload
    await state.bus.broadcast({"type": "content_regions", "regions": payload})
    await state.bus.broadcast(
        {"type": "content_capture", "image": picture, "bbox": list(area), "regions": payload}
    )
    found = len(regions)
    await state.bus.broadcast(
        read_status_event("ok", f"Found {found} piece{'s' if found != 1 else ''} of writing.")
    )
    return False
