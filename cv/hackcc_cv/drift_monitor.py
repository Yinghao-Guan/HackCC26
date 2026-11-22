"""The drift monitor: watches the printed markers and recalibrates when the camera moved.

A few times a second it finds the printed markers (ids 40-47) in the latest frame and
asks DriftMonitor whether the camera moved. On a confirmed move the calibration is
marked stale (so nobody trusts old positions); once the camera is still again, it runs
the automatic calibration by itself (unless --no-auto-recalibrate). If the camera is put
back where it was, the old calibration is trusted again.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from .aruco import detect_markers, make_detector
from .auto_calibration import run_auto_calibration
from .drift import DriftMonitor, DriftVerdict, static_markers_in

if TYPE_CHECKING:
    from .state import ServerState

log = logging.getLogger(__name__)

CHECK_EVERY_SECONDS = 0.25
RETRY_AFTER_FAILURE_SECONDS = 10.0  # doubles after each failed try
MAX_AUTO_TRIES = 3
MOVED = "The camera moved, so touch positions can't be trusted. Recalibrating when it is still…"
MOVED_MANUAL = "The camera moved, so touch positions can't be trusted. Calibrate again."
GAVE_UP = (
    "The camera moved and automatic recalibration gave up after "
    f"{MAX_AUTO_TRIES} tries. Check the board and camera, then calibrate again."
)
CANCELLED = "The camera moved; automatic recalibration was cancelled. Calibrate again when ready."

MESSAGES = {
    "off": "No printed markers were seen at calibration, so camera moves can't be noticed.",
    "unknown": "Fewer than 2 printed markers visible right now (covered?).",
    "steady": "The camera is where it was at calibration.",
    "checking": "The printed markers seem to have moved; checking…",
    "moved": "The camera moved; waiting for it to be still…",
    "recalibrate": "The camera is still again.",
}


def drift_event(verdict: DriftVerdict) -> dict[str, Any]:
    return {
        "type": "drift",
        "status": verdict.status,
        "shift_px": verdict.shift_px,
        "seen": verdict.seen,
        "message": MESSAGES[verdict.status],
    }


def _report_crash(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("Automatic recalibration crashed", exc_info=task.exception())


async def _recalibrate(state: ServerState) -> str:
    """Run the automatic calibration: "ok", "failed" or "cancelled" (by the user)."""
    before = state.calibration.current()
    task = asyncio.create_task(run_auto_calibration(state))
    task.add_done_callback(_report_crash)
    state.auto_task = task
    await asyncio.wait({task})
    if task.cancelled():
        return "cancelled"
    return "ok" if state.calibration.current() is not before else "failed"


async def _stop_auto(state: ServerState, message: str) -> None:
    state.drift_problem = message
    await state.announce_calibration()


async def run_drift_monitor(state: ServerState) -> None:
    monitor, detector = DriftMonitor(), make_detector()
    loop = asyncio.get_running_loop()
    last_status: str | None = None
    retry_at, failures, stopped = 0.0, 0, False
    watched = None  # the calibration the monitor's counts belong to
    while True:
        await asyncio.sleep(CHECK_EVERY_SECONDS)
        calibration, camera = state.calibration.current(), state.camera
        frame = camera.latest() if camera is not None else None
        if frame is None or state.calibration_running():
            continue  # a calibration or board read is using the board right now
        if calibration is not watched:  # a new calibration: start fresh
            watched, failures, stopped = calibration, 0, False
            monitor.reset()

        found = static_markers_in(await asyncio.to_thread(detect_markers, frame.image, detector))
        if state.calibration.current() is not calibration:
            continue  # replaced while we looked: this check compares against the old one
        verdict = monitor.update(calibration.static() if calibration else [], found)
        if verdict.status != last_status:
            last_status = verdict.status
            await state.bus.broadcast(drift_event(verdict))

        if verdict.status in ("moved", "recalibrate") and not state.drift_problem:
            state.drift_problem = MOVED if state.config.auto_recalibrate else MOVED_MANUAL
            log.warning("Camera moved (median shift %.1f px)", verdict.shift_px)
            await state.announce_calibration()
        elif verdict.status == "steady" and state.drift_problem:
            state.drift_problem = ""  # put back where it was: the calibration fits again
            failures, stopped = 0, False
            await state.announce_calibration()

        if (
            verdict.status == "recalibrate"
            and state.config.auto_recalibrate
            and not stopped
            and loop.time() >= retry_at
            and not state.calibration_running()
        ):
            log.info("Recalibrating after the camera moved (try %d)", failures + 1)
            outcome = await _recalibrate(state)
            if outcome == "cancelled":
                stopped = True  # the user said stop: don't flash the grid again by ourselves
                await _stop_auto(state, CANCELLED)
            elif outcome == "failed":
                failures += 1
                if failures >= MAX_AUTO_TRIES:
                    stopped = True
                    await _stop_auto(state, GAVE_UP)
                else:
                    retry_at = loop.time() + RETRY_AFTER_FAILURE_SECONDS * 2 ** (failures - 1)
            monitor.reset()
            last_status = None
