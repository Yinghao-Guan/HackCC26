"""The CV service: one WebSocket that every part of the whiteboard listens to.

Routes:
  /ws           the event bus (JSON messages, see events.py)
  /health       status as JSON
  /preview.mjpg live camera view with the frame rate, for setting up
  /debug        a test page that shows the bus and draws what a board page draws
  /calibrate    the operator page for the manual four-corner calibration
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.websockets import WebSocketDisconnect

from . import __version__
from .calibration import CalibrationError, load_calibration
from .camera import Camera, CameraError, StatusListener
from .config import Config
from .events import (
    MessageError,
    camera_status_event,
    error_event,
    parse_client_message,
)
from .fake import run_fake_pointer
from .handlers import handle_message
from .preview import annotate, encode_jpeg
from .state import ServerState

log = logging.getLogger(__name__)

STATIC = Path(__file__).resolve().parent / "static"
PREVIEW_FPS = 15
PREVIEW_STALL_SECONDS = 5.0
POLICY_VIOLATION = 1008  # WebSocket close code

CameraFactory = Callable[[Config, StatusListener], Camera]


def _default_camera(config: Config, on_status: StatusListener) -> Camera:
    return Camera(config, on_status=on_status)


class _SerialSocket:
    """A WebSocket whose sends never overlap (the bus and replies share it)."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._lock = asyncio.Lock()

    async def send_json(self, data: Any) -> None:
        async with self._lock:
            await self.websocket.send_json(data)


def _render_preview(image: Any, fps: float, label: str) -> bytes:
    return encode_jpeg(annotate(image, fps, label))


def _status_to_event(status: dict[str, Any]) -> dict[str, Any]:
    details = {k: v for k, v in status.items() if k not in ("status", "message")}
    return camera_status_event(status["status"], message=status["message"], details=details)


def _load_saved_calibration(state: ServerState) -> None:
    try:
        saved = load_calibration(state.config.data_dir)
    except CalibrationError as error:
        state.calibration_problem = f"The saved calibration could not be used: {error} Recalibrate."
        log.error("%s", state.calibration_problem)
        return
    if saved is not None:
        state.calibration.set(saved)
        log.info("Loaded the %s calibration from %s", saved.method, state.config.data_dir)
    # New pages get the status when they connect; after that only changes are announced.
    state.remember_announced(state.calibration_event())


def create_app(config: Config, camera_factory: CameraFactory = _default_camera) -> FastAPI:
    state = ServerState(config)
    bus = state.bus

    def camera_status() -> dict[str, Any]:
        if state.camera is None:
            return {"status": "off", "message": "Camera is turned off (--no-camera)."}
        return state.camera.status()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        bus.attach_loop(asyncio.get_running_loop())
        _load_saved_calibration(state)
        if config.camera_enabled:
            loop = asyncio.get_running_loop()

            def on_camera_status(status: dict[str, Any]) -> None:
                # Runs on the camera thread. A new camera size can make the calibration stale.
                bus.publish_threadsafe(_status_to_event(status))
                with contextlib.suppress(RuntimeError):  # loop closed while shutting down
                    asyncio.run_coroutine_threadsafe(state.announce_calibration(), loop)

            camera = camera_factory(config, on_camera_status)
            state.camera = camera
            try:
                await asyncio.to_thread(camera.start)
                log.info("Camera ready: %s", camera.status())
            except CameraError as error:
                # Keep serving: the UI shows the error and the fake pointer still works.
                log.error("%s", error)

        fake_task = None
        if config.fake_pointer:
            fake_task = asyncio.create_task(run_fake_pointer(bus.broadcast, lambda: state.display))

        try:
            yield
        finally:
            state.shutting_down = True
            for task in (fake_task, state.auto_task):
                if task is not None and not task.done():
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
            if state.camera is not None:
                await asyncio.to_thread(state.camera.stop)

    app = FastAPI(title="HackCC26 CV service", version=__version__, lifespan=lifespan)
    # Only answer requests addressed to this machine by name. Without this, a web page
    # could point its own domain at 127.0.0.1 (DNS rebinding) and read the camera preview.
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=sorted({"127.0.0.1", "localhost", config.host})
    )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        display = state.display
        return {
            "ok": True,
            "version": __version__,
            "camera": camera_status(),
            "calibration": state.calibration_event(),
            "clients": bus.client_count,
            "fake_pointer": config.fake_pointer,
            "display": {"width": display.width, "height": display.height, "dpr": display.dpr},
        }

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse("/debug")

    @app.get("/debug", response_class=HTMLResponse)
    async def debug_page() -> str:
        return (STATIC / "debug.html").read_text(encoding="utf-8")

    @app.get("/calibrate", response_class=HTMLResponse)
    async def calibrate_page() -> str:
        return (STATIC / "calibrate.html").read_text(encoding="utf-8")

    @app.get("/preview.mjpg", response_model=None)
    async def preview() -> StreamingResponse | JSONResponse:
        camera = state.camera
        if camera is None or camera.status()["status"] != "ok":
            return JSONResponse({"error": camera_status()["message"] or "No camera."}, status_code=503)

        async def frames() -> AsyncIterator[bytes]:
            # Ends when the camera fails or stalls, so the page shows a broken image
            # instead of silently freezing on the last frame.
            last_index = -1
            last_new_frame = time.monotonic()
            label = f"cam {config.camera_index}"
            while not state.shutting_down and camera.status()["status"] == "ok":
                frame = camera.latest()
                if frame is not None and frame.index != last_index:
                    last_index = frame.index
                    last_new_frame = time.monotonic()
                    jpeg = await asyncio.to_thread(_render_preview, frame.image, camera.fps, label)
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg + b"\r\n"
                elif time.monotonic() - last_new_frame > PREVIEW_STALL_SECONDS:
                    return
                await asyncio.sleep(1 / PREVIEW_FPS)

        return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")

    @app.websocket("/ws")
    async def events(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in config.allowed_origins:
            log.warning("Refused a WebSocket from %s", origin)
            await websocket.close(code=POLICY_VIOLATION)
            return

        await websocket.accept()
        client = _SerialSocket(websocket)
        bus.add(client)  # before the first status, so no change can slip in between
        try:
            await client.send_json(_status_to_event(camera_status()))
            await client.send_json(state.calibration_event())
            await _serve(websocket, client, state)
        except WebSocketDisconnect:
            pass
        finally:
            bus.remove(client)

    return app


async def _serve(websocket: WebSocket, client: _SerialSocket, state: ServerState) -> None:
    """Answer one page's messages until it disconnects."""
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return
        raw = message.get("text")
        if raw is None:
            await client.send_json(error_event("Send text (JSON) messages, not binary."))
            continue
        try:
            parsed = parse_client_message(raw)
        except MessageError as error:
            await client.send_json(error_event(str(error)))
            continue
        await handle_message(parsed, client, state)
