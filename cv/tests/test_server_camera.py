"""The server with a (fake) camera attached: status reporting and failures."""

import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from hackcc_cv.camera import Camera
from hackcc_cv.config import Config
from hackcc_cv.server import create_app
from tests.test_camera import FakeCapture, wait_for


def camera_factory(opened: bool):
    def factory(config, on_status):
        return Camera(
            config,
            capture_factory=lambda index, backend: FakeCapture(index, backend, opened=opened),
            on_status=on_status,
        )

    return factory


def make_client(opened: bool) -> TestClient:
    config = Config(camera_enabled=True, warmup_seconds=0.0, data_dir=Path(tempfile.mkdtemp()))
    return TestClient(create_app(config, camera_factory=camera_factory(opened)), base_url="http://127.0.0.1:8765")


def test_health_reports_a_working_camera():
    with make_client(opened=True) as client:
        assert wait_for(lambda: client.get("/health").json()["camera"]["fps"] > 0)
        camera = client.get("/health").json()["camera"]
    assert camera["status"] == "ok"
    assert (camera["width"], camera["height"]) == (64, 48)


def test_new_browsers_are_told_the_camera_status():
    with make_client(opened=True) as client, client.websocket_connect("ws://127.0.0.1:8765/ws") as ws:
        event = ws.receive_json()
    assert event["type"] == "camera"
    assert event["status"] == "ok"


def test_a_camera_that_fails_to_open_is_reported_and_the_server_keeps_running():
    with make_client(opened=False) as client:
        camera = client.get("/health").json()["camera"]
        assert camera["status"] == "error"
        assert "Could not open camera 0" in camera["message"]
        with client.websocket_connect("ws://127.0.0.1:8765/ws") as ws:
            event = ws.receive_json()
        assert event["status"] == "error"
        assert client.get("/preview.mjpg").status_code == 503
