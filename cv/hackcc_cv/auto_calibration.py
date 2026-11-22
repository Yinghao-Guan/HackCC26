"""Automatic calibration: show the ArUco grid on the board, find it, compute the mapping.

Flow (docs/05-setup-checklist.md, section 3): show the pattern, wait for the board
page to confirm and the image to settle, grab frames, take the median corners,
solve with RANSAC, check the result, retry a few times, then save or explain why not.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

import numpy as np

from .aruco import (
    AutoCalibrationError,
    Solution,
    detect_markers,
    make_detector,
    median_corners,
    solve,
)
from .calibration import Calibration, calibration_status_event
from .camera import Camera
from .drift import StaticMarker, static_markers_in
from .markers import PatternMarker, grid_layout, pattern_event

if TYPE_CHECKING:
    from .handlers import ServerState

log = logging.getLogger(__name__)

FRAMES_PER_ATTEMPT = 15
ATTEMPTS = 3
ACK_TIMEOUT_SECONDS = 3.0  # how long the board page has to confirm it shows the pattern
SETTLE_SECONDS = 0.4  # projector and camera catch up after the pattern appears
FRAME_TIMEOUT_SECONDS = 3.0
RETRY_PAUSE_SECONDS = 0.3


def collect_frames(camera: Camera, count: int, timeout: float) -> list[np.ndarray]:
    """Up to `count` new camera images (blocking; run it in a thread)."""
    images: list[np.ndarray] = []
    last_index = -1
    deadline = time.monotonic() + timeout
    while len(images) < count and time.monotonic() < deadline:
        frame = camera.latest()
        if frame is not None and frame.index != last_index:
            last_index = frame.index
            images.append(frame.image)
        else:
            time.sleep(0.005)
    return images


def _find_and_solve(
    images: list[np.ndarray], layout: list[PatternMarker]
) -> tuple[Solution, list[StaticMarker]]:
    """Runs in a thread: detection is CPU work. Also notes the printed markers it saw."""
    detector = make_detector()
    corners = median_corners([detect_markers(image, detector) for image in images])
    return solve(corners, layout), static_markers_in(corners)


async def _progress(state: ServerState, message: str) -> None:
    event = calibration_status_event("calibrating", state.calibration.current(), message)
    state.remember_announced(event)
    await state.bus.broadcast(event)


async def _fail(state: ServerState, reason: str, *, pattern_shown: bool) -> None:
    await state.refuse_calibration(reason)
    if pattern_shown:
        await state.bus.broadcast(pattern_event([]))


async def _after_cancel(state: ServerState) -> None:
    await state.bus.broadcast(pattern_event([]))
    await state.announce_calibration(force=True)


async def run_auto_calibration(state: ServerState) -> None:
    """The whole automatic calibration. Cancelling it hides the pattern."""
    async with state.calibration_lock:
        try:
            await _calibrate(state)
        except asyncio.CancelledError:
            # Shielded: a second Cancel must not stop the clean-up half way.
            await asyncio.shield(_after_cancel(state))
            raise
        except Exception:
            log.exception("Automatic calibration failed unexpectedly")
            await _fail(
                state,
                "Calibration failed unexpectedly. Check the CV service log, then try again.",
                pattern_shown=True,
            )


async def wait_for_camera_size(state: ServerState) -> tuple[int, int] | None:
    """The camera says "ok" when it opens, but its size is known only after the first
    frame; a calibration started right then must wait for it, not fail."""
    deadline = time.monotonic() + FRAME_TIMEOUT_SECONDS
    while state.camera is not None and time.monotonic() < deadline:
        size = state.camera_size()
        if size is not None:
            return size
        if state.camera.status()["status"] == "error":
            return None
        await asyncio.sleep(0.05)
    return None


async def _calibrate(state: ServerState) -> None:
    camera, camera_size = state.camera, await wait_for_camera_size(state)
    if camera is None or camera_size is None:
        await _fail(
            state,
            "The camera is not running, so the board can't be seen. Check the camera, then try again.",
            pattern_shown=False,
        )
        return

    board = state.display
    layout = grid_layout(board)
    state.pattern_shown.clear()
    state.pattern_run += 1
    await _progress(state, "Showing the calibration pattern on the board…")
    await state.bus.broadcast(pattern_event(layout, state.pattern_run))
    try:
        await asyncio.wait_for(state.pattern_shown.wait(), ACK_TIMEOUT_SECONDS)
    except TimeoutError:
        await _fail(
            state,
            "No board page showed the pattern. Open the board page fullscreen on the projector, "
            "then try again.",
            pattern_shown=True,
        )
        return
    await asyncio.sleep(SETTLE_SECONDS)

    last_error = "The markers were not found."
    for attempt in range(1, ATTEMPTS + 1):
        if state.display != board:
            await _fail(
                state, "The board page changed size during calibration. Try again.", pattern_shown=True
            )
            return
        await _progress(state, f"Looking for the markers (try {attempt} of {ATTEMPTS})…")
        images = await asyncio.to_thread(collect_frames, camera, FRAMES_PER_ATTEMPT, FRAME_TIMEOUT_SECONDS)
        try:
            solution, statics = await asyncio.to_thread(_find_and_solve, images, layout)
            break
        except AutoCalibrationError as error:
            last_error = str(error)
            log.info("Calibration try %d failed: %s", attempt, error)
            await asyncio.sleep(RETRY_PAUSE_SECONDS)
    else:
        await _fail(state, last_error, pattern_shown=True)
        return

    log.info(
        "Auto calibration: %d markers, error %.2f px (max %.2f)",
        solution.markers_found, solution.error_px, solution.max_error_px,
    )
    calibration = Calibration.from_matrix(
        solution.matrix,
        method="aruco",
        camera_size=camera_size,
        board_size=(board.width, board.height),
        reprojection_error_px=solution.error_px,
        points=solution.points,
        static_markers=statics,
    )
    # Shielded: once saving starts, the saved file and the one in use must match.
    await asyncio.shield(state.adopt_calibration(calibration))
    await state.bus.broadcast(pattern_event([]))
