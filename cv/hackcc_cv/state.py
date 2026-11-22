"""What the server remembers between messages, and the calibration steps both
calibration methods share (adopting a result, refusing with a reason)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

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
from .drift import MIN_MARKERS
from .events import DEFAULT_DISPLAY, Display, calibration_targets_event
from .tracking import TrackingLoop

log = logging.getLogger(__name__)

NO_PRINTED_MARKERS = (
    "Calibrated, but fewer than 2 printed markers were seen, so camera moves will not be "
    "noticed. Stick printed markers (/markers) around the board and calibrate again."
)


class ServerState:
    """`display` is the board page's size, set by the page that says hello as "board".
    Keep only one board page open at a time."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.bus = Bus()
        self.display: Display = DEFAULT_DISPLAY
        self.camera: Camera | None = None
        self.tracking: TrackingLoop | None = None
        self.calibration = CalibrationStore()
        self.calibration_problem = ""  # set when the saved calibration could not be loaded
        self.save_problem = ""  # set when the calibration in use could not be saved
        self.drift_problem = ""  # set while the printed markers say the camera moved
        self.drift_task: asyncio.Task[None] | None = None
        # Manual calibration: the targets on show, and the board size they were placed for.
        self.targets: list[tuple[float, float]] | None = None
        self.targets_display: Display | None = None
        # Automatic calibration: the running task, and the board page's "pattern is shown".
        self.auto_task: asyncio.Task[None] | None = None
        self.pattern_shown = asyncio.Event()
        self.pattern_run = 0  # numbers each showing of the pattern
        # Reading the board: the running task, the white flash's confirmation, the result.
        self.read_task: asyncio.Task[None] | None = None
        self.flash_shown = asyncio.Event()
        self.flash_run = 0
        self.content_regions: list[dict[str, Any]] = []
        self.calibration_lock = asyncio.Lock()  # one calibration at a time
        self.last_calibration_key: tuple[str, str] | None = None
        self.shutting_down = False

    # -- status ---------------------------------------------------------------

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
        if self.drift_problem:
            return calibration_status_event("stale", current, self.drift_problem)
        reason = stale_reason(current, self.display, self.camera_size())
        if reason is not None:
            return calibration_status_event("stale", current, reason)
        if self.save_problem:
            return calibration_status_event("ok", current, self.save_problem)
        if len(current.static()) < MIN_MARKERS:
            return calibration_status_event("ok", current, NO_PRINTED_MARKERS)
        return calibration_status_event("ok", current)

    def remember_announced(self, event: dict[str, Any]) -> None:
        self.last_calibration_key = (event["status"], event["message"])

    async def announce_calibration(self, *, force: bool = False) -> None:
        """Broadcast the calibration status if it changed (or always, with force).

        While a calibration runs it reports its own progress, so other triggers (a page
        saying hello, a camera status change) must not overwrite "calibrating".
        """
        if not force and self.calibration_running():
            return
        event = self.calibration_event()
        if force or (event["status"], event["message"]) != self.last_calibration_key:
            self.remember_announced(event)
            await self.bus.broadcast(event)

    def calibration_running(self) -> bool:
        return self.calibration_lock.locked() or any(
            task is not None and not task.done() for task in (self.auto_task, self.read_task)
        )

    # -- manual targets -------------------------------------------------------

    def show_targets(self) -> list[tuple[float, float]]:
        self.targets = manual_targets(self.display)
        self.targets_display = self.display
        return self.targets

    def hide_targets(self) -> None:
        self.targets = None
        self.targets_display = None

    # -- results --------------------------------------------------------------

    async def refuse_calibration(self, reason: str) -> None:
        """Tell every page the attempt failed and why; the previous calibration stays."""
        event = calibration_status_event("error", self.calibration.current(), reason)
        self.remember_announced(event)
        await self.bus.broadcast(event)

    async def adopt_calibration(self, calibration: Calibration) -> None:
        """Save, start using and announce a new calibration."""
        try:
            path = await asyncio.to_thread(save_calibration, calibration, self.config.data_dir)
            log.info("Saved the %s calibration to %s", calibration.method, path)
            self.save_problem = ""
        except OSError as error:
            log.error("Could not save the calibration: %s", error)
            self.save_problem = (
                f"Calibrated, but it could not be saved ({error}). "
                "It will be lost when the service restarts."
            )
        self.calibration.set(calibration)
        self.calibration_problem = ""
        self.drift_problem = ""  # a fresh calibration fits wherever the camera is now
        self.hide_targets()
        await self.announce_calibration(force=True)
        await self.bus.broadcast(calibration_targets_event([]))
