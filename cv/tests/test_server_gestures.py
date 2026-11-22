"""Hand tracking inside the server: gestures from a scripted tracker reach the pages."""

import numpy as np
from fastapi.testclient import TestClient

from hackcc_cv.camera import Camera
from hackcc_cv.config import Config, load_config
from hackcc_cv.server import create_app
from tests.hand_shapes import make_hand
from tests.test_camera import wait_for
from tests.test_server_auto_calibration import ImageCapture
from tests.test_tracking import ScriptedTracker

WS_URL = "ws://127.0.0.1:8765/ws"


def make_client(tmp_path, gestures=True):
    config = Config(camera_enabled=True, warmup_seconds=0.0, gestures=gestures, data_dir=tmp_path)
    blank = np.zeros((720, 1280, 3), np.uint8)

    def camera_factory(cfg, on_status):
        return Camera(cfg, capture_factory=lambda i, b: ImageCapture(blank), on_status=on_status)

    def tracker_factory():
        return ScriptedTracker(lambda n: [make_hand("pinch", at=(500, 500))])

    app = create_app(config, camera_factory=camera_factory, tracker_factory=tracker_factory)
    return TestClient(app, base_url="http://127.0.0.1:8765")


def test_a_held_pinch_reaches_the_page_as_a_rotate(tmp_path):
    with make_client(tmp_path) as client, client.websocket_connect(WS_URL) as ws:
        kinds = []
        for _ in range(200):
            event = ws.receive_json()
            kinds.append(event["type"])
            if event["type"] == "rotate":
                assert event["phase"] == "start"
                break
        assert "rotate" in kinds
        assert "hands" in kinds
        assert wait_for(lambda: client.get("/health").json()["tracking"]["status"] == "ok")


def test_pages_that_connect_later_are_told_the_tracking_status(tmp_path):
    with make_client(tmp_path) as client:
        assert wait_for(lambda: client.get("/health").json()["tracking"]["status"] == "ok")
        with client.websocket_connect(WS_URL) as ws:
            # Live gesture events may interleave with the greeting, so look at the first few.
            first = [ws.receive_json() for _ in range(6)]
    tracking = [e for e in first if e["type"] == "tracking"]
    assert tracking and tracking[0]["status"] == "ok"


def test_gestures_can_be_turned_off(tmp_path):
    with make_client(tmp_path, gestures=False) as client:
        assert client.get("/health").json()["tracking"]["status"] == "off"


def test_no_gestures_flag_and_environment_variable():
    assert load_config(env={}, argv=["--no-gestures"]).gestures is False
    assert load_config(env={"CV_GESTURES": "0"}, argv=[]).gestures is False
    assert load_config(env={}, argv=[]).gestures is True
