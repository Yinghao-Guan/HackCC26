"""What the server does with each message a page sends."""

from __future__ import annotations

import asyncio
import logging
import math
from typing import Any, Protocol

from .bus import Bus
from .calibration import (
    Calibration,
    CalibrationStore,
    calibration_status_event,
    manual_targets,
    save_calibration,
    stale_reason,
)
from .camera import Camera
from .config import Config
from .events import (
    DEFAULT_DISPLAY,
    CancelCalibration,
    ClientMessage,
    Display,
    Hello,
    ManualCalibration,
    MapPoint,
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

log = logging.getLogger(__name__)


class Sender(Protocol):
    async def send_json(self, data: Any) -> None: ...


class ServerState:
    """What the server remembers between messages.

    `display` is the board page's size, set by the page that says hello as "board".
    Keep only one board page open at a time.
    """

    def __init__(self, config: Config) -> None:
        self.config = config
        self.bus = Bus()
        self.display: Display = DEFAULT_DISPLAY
        self.camera: Camera | None = None
        self.calibration = CalibrationStore()
        self.calibration_problem = ""  # set when the saved calibration could not be loaded
        self.save_problem = ""  # set when the calibration in use could not be saved
        # The targets on show, and the board size they were placed for.
        self.targets: list[tuple[float, float]] | None = None
        self.targets_display: Display | None = None
        self.calibration_lock = asyncio.Lock()  # one calibration at a time
        self.last_calibration_key: tuple[str, str] | None = None
        self.shutting_down = False

    def camera_size(self) -> tuple[int, int] | None:
        if self.camera is None:
            return None
        status = self.camera.status()
        if status["status"] != "ok" or not status["width"]:
            return None
        return int(status["width"]), int(status["height"])

    def calibration_event(self) -> dict[str, Any]:
        current = self.calibration.current()
        if current is None:
            if self.calibration_problem:
                return calibration_status_event("error", message=self.calibration_problem)
            return calibration_status_event("none", message="Not calibrated yet.")
        reason = stale_reason(current, self.display, self.camera_size())
        if reason is not None:
            return calibration_status_event("stale", current, reason)
        if self.save_problem:
            return calibration_status_event("ok", current, self.save_problem)
        return calibration_status_event("ok", current)

    def remember_announced(self, event: dict[str, Any]) -> None:
        self.last_calibration_key = (event["status"], event["message"])

    async def announce_calibration(self, *, force: bool = False) -> None:
        """Broadcast the calibration status if it changed (or always, with force)."""
        event = self.calibration_event()
        if force or (event["status"], event["message"]) != self.last_calibration_key:
            self.remember_announced(event)
            await self.bus.broadcast(event)

    def show_targets(self) -> list[tuple[float, float]]:
        self.targets = manual_targets(self.display)
        self.targets_display = self.display
        return self.targets

    def hide_targets(self) -> None:
        self.targets = None
        self.targets_display = None


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
        state.hide_targets()
        await state.bus.broadcast(calibration_targets_event([]))
    elif isinstance(message, ManualCalibration):
        async with state.calibration_lock:
            await _calibrate_manually(message, state)
    elif isinstance(message, MapPoint):
        await _map_point(message, client, state)


async def _refuse_calibration(state: ServerState, reason: str) -> None:
    event = calibration_status_event("error", state.calibration.current(), reason)
    state.remember_announced(event)
    await state.bus.broadcast(event)


async def _calibrate_manually(message: ManualCalibration, state: ServerState) -> None:
    camera_size = state.camera_size() or message.camera_size
    # The board size the targets were drawn for; without a start, the current board.
    board = state.targets_display or state.display
    if board != state.display:
        await _refuse_calibration(
            state, "The board page changed size during calibration. Press Show targets again."
        )
        return
    targets = state.targets or manual_targets(board)
    try:
        validate_quad(message.camera_points, camera_size)
        matrix = homography_from_points(message.camera_points, targets)
    except HomographyError as error:
        await _refuse_calibration(state, str(error))
        return

    calibration = Calibration.from_matrix(
        matrix,
        method="manual",
        camera_size=camera_size,
        board_size=(board.width, board.height),
        reprojection_error_px=reprojection_error(matrix, message.camera_points, targets),
        points=len(targets),
    )
    try:
        path = await asyncio.to_thread(save_calibration, calibration, state.config.data_dir)
        log.info("Saved manual calibration to %s", path)
        state.save_problem = ""
    except OSError as error:
        log.error("Could not save the calibration: %s", error)
        state.save_problem = (
            f"Calibrated, but it could not be saved ({error}). "
            "It will be lost when the service restarts."
        )
    state.calibration.set(calibration)
    state.calibration_problem = ""
    state.hide_targets()
    await state.announce_calibration(force=True)
    await state.bus.broadcast(calibration_targets_event([]))


PROBE_MARGIN = 1.0  # a check cross may land up to one board size beyond each edge


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
