"""What the server does with each message a page sends."""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Protocol

from .auto_calibration import run_auto_calibration
from .calibration import Calibration, manual_targets
from .events import (
    CalibrateAuto,
    CancelCalibration,
    ClientMessage,
    Hello,
    ManualCalibration,
    MapPoint,
    PatternShown,
    Ping,
    StartManualCalibration,
    calibration_probe_event,
    calibration_targets_event,
    error_event,
    hello_ack_event,
    pong_event,
)
from .homography import (
    HomographyError,
    homography_from_points,
    map_point,
    reprojection_error,
    validate_quad,
)
from .state import ServerState

log = logging.getLogger(__name__)

PROBE_MARGIN = 1.0  # a check cross may land up to one board size beyond each edge
BUSY = "A calibration is already running. Wait for it, or press Cancel."


class Sender(Protocol):
    async def send_json(self, data: Any) -> None: ...


async def handle_message(message: ClientMessage, client: Sender, state: ServerState) -> None:
    if isinstance(message, Hello):
        if message.role == "board":
            state.display = message.display
        await client.send_json(hello_ack_event(message.display))
        await state.announce_calibration()
    elif isinstance(message, Ping):
        await client.send_json(pong_event())
    elif isinstance(message, StartManualCalibration):
        await state.bus.broadcast(calibration_targets_event(state.show_targets()))
    elif isinstance(message, CancelCalibration):
        await _cancel(state)
    elif isinstance(message, ManualCalibration):
        await _calibrate_manually(message, client, state)
    elif isinstance(message, CalibrateAuto):
        if state.calibration_running():
            await client.send_json(error_event(BUSY))
            return
        state.auto_task = asyncio.create_task(run_auto_calibration(state))
        state.auto_task.add_done_callback(_report_crash)
    elif isinstance(message, PatternShown):
        # Only a reply to the pattern on show now counts, not one from an earlier try.
        if message.run == state.pattern_run:
            state.pattern_shown.set()
    elif isinstance(message, MapPoint):
        await _map_point(message, client, state)


def _report_crash(task: asyncio.Task[None]) -> None:
    """Background tasks fail silently unless someone looks; log the reason."""
    if not task.cancelled() and task.exception() is not None:
        log.error("Automatic calibration crashed", exc_info=task.exception())


async def _cancel(state: ServerState) -> None:
    state.hide_targets()
    await state.bus.broadcast(calibration_targets_event([]))
    task = state.auto_task
    if task is not None and not task.done():
        task.cancel()  # the task hides the pattern and re-announces the status


async def _calibrate_manually(message: ManualCalibration, client: Sender, state: ServerState) -> None:
    if state.calibration_running():
        await client.send_json(error_event(BUSY))
        return
    async with state.calibration_lock:
        camera_size = state.camera_size() or message.camera_size
        # The board size the targets were drawn for; without a start, the current board.
        board = state.targets_display or state.display
        if board != state.display:
            await state.refuse_calibration(
                "The board page changed size during calibration. Press Show targets again."
            )
            return
        targets = state.targets or manual_targets(board)
        try:
            validate_quad(message.camera_points, camera_size)
            matrix = homography_from_points(message.camera_points, targets)
        except HomographyError as error:
            await state.refuse_calibration(str(error))
            return

        await state.adopt_calibration(
            Calibration.from_matrix(
                matrix,
                method="manual",
                camera_size=camera_size,
                board_size=(board.width, board.height),
                reprojection_error_px=reprojection_error(matrix, message.camera_points, targets),
                points=len(targets),
            )
        )


def _near_board(point: tuple[float, float], board_size: tuple[float, float]) -> bool:
    x, y = point
    width, height = board_size
    if not (math.isfinite(x) and math.isfinite(y)):
        return False
    return (
        -PROBE_MARGIN * width <= x <= (1 + PROBE_MARGIN) * width
        and -PROBE_MARGIN * height <= y <= (1 + PROBE_MARGIN) * height
    )


async def _map_point(message: MapPoint, client: Sender, state: ServerState) -> None:
    current = state.calibration.current()
    if current is None:
        await client.send_json(error_event("Not calibrated yet. Run the calibration first."))
        return
    board_point = map_point(current.matrix(), *message.camera_point)
    if not _near_board(board_point, current.board_size):
        # Also keeps NaN/infinity out of JSON, which would fail for every page.
        await client.send_json(error_event("That point is outside the board."))
        return
    await state.bus.broadcast(calibration_probe_event(board_point, message.camera_point))
