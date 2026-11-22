"""Automatic ArUco calibration over the WebSocket, with a fake camera looking at a fake board."""

import time
from contextlib import contextmanager

import numpy as np
import pytest
from fastapi.testclient import TestClient

from hackcc_cv import auto_calibration
from hackcc_cv.calibration import load_calibration
from hackcc_cv.camera import Camera
from hackcc_cv.config import Config
from hackcc_cv.events import Display
from hackcc_cv.markers import grid_layout
from hackcc_cv.server import create_app
from tests.synthetic import BOARD_SIZE, camera_frame

WS_URL = "ws://127.0.0.1:8765/ws"


class ImageCapture:
    """A camera that always shows the same picture."""

    def __init__(self, image):
        self.image = image

    def isOpened(self):
        return True

    def set(self, prop, value):
        return True

    def read(self):
        time.sleep(0.005)
        return True, self.image.copy()

    def release(self):
        pass


@pytest.fixture(autouse=True)
def fast_timings(monkeypatch):
    monkeypatch.setattr(auto_calibration, "FRAMES_PER_ATTEMPT", 4)
    monkeypatch.setattr(auto_calibration, "SETTLE_SECONDS", 0.05)
    monkeypatch.setattr(auto_calibration, "ACK_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(auto_calibration, "RETRY_PAUSE_SECONDS", 0.01)


def make_client(tmp_path, image=None):
    config = Config(camera_enabled=image is not None, warmup_seconds=0.0, gestures=False, data_dir=tmp_path)

    def factory(cfg, on_status):
        return Camera(cfg, capture_factory=lambda i, b: ImageCapture(image), on_status=on_status)

    return TestClient(create_app(config, camera_factory=factory), base_url="http://127.0.0.1:8765")


@contextmanager
def board_page(client):
    with client.websocket_connect(WS_URL) as ws:
        ws.receive_json()  # camera
        ws.receive_json()  # calibration
        ws.send_json({"type": "hello", "width": BOARD_SIZE[0], "height": BOARD_SIZE[1], "dpr": 1})
        next_of(ws, "hello_ack")
        yield ws


def next_of(ws, kind, limit=40):
    for _ in range(limit):
        event = ws.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"no {kind} event")


def final_status(ws):
    """Skip progress updates and return the finished calibration status."""
    for _ in range(40):
        event = next_of(ws, "calibration")
        if event["status"] != "calibrating":
            return event
    raise AssertionError("calibration never finished")


def test_auto_calibration_shows_the_pattern_finds_it_and_saves(tmp_path):
    layout = grid_layout(Display(*BOARD_SIZE, 1))
    with make_client(tmp_path, camera_frame(layout)) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        pattern = next_of(ws, "calibration_pattern")
        assert [m["id"] for m in pattern["markers"]] == list(range(12))
        ws.send_json({"type": "calibration_pattern_shown", "run": pattern["run"]})

        status = final_status(ws)
        assert status["status"] == "ok", status["message"]
        assert status["method"] == "aruco"
        assert status["points"] == 48
        assert status["reproj_error_px"] < 1.0
        assert next_of(ws, "calibration_pattern")["markers"] == []

    saved = load_calibration(tmp_path)
    assert saved is not None and saved.method == "aruco"


def test_without_a_camera_auto_calibration_explains_why(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        status = final_status(ws)
    assert status["status"] == "error"
    assert "camera" in status["message"].lower()


def test_no_board_page_showing_the_pattern_is_an_error(tmp_path):
    layout = grid_layout(Display(*BOARD_SIZE, 1))
    with make_client(tmp_path, camera_frame(layout)) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        next_of(ws, "calibration_pattern")  # but never say it is shown
        status = final_status(ws)
        assert status["status"] == "error"
        assert "board page" in status["message"]
        assert next_of(ws, "calibration_pattern")["markers"] == []


def test_a_camera_that_cannot_see_the_pattern_reports_how_many_markers(tmp_path):
    blank = np.full((720, 1280, 3), 128, np.uint8)
    with make_client(tmp_path, blank) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        pattern = next_of(ws, "calibration_pattern")
        ws.send_json({"type": "calibration_pattern_shown", "run": pattern["run"]})
        status = final_status(ws)
    assert status["status"] == "error"
    assert "0 of 12" in status["message"]
    assert load_calibration(tmp_path) is None


def test_an_unexpected_crash_hides_the_pattern_and_reports_an_error(tmp_path, monkeypatch):
    def explode(images, layout):
        raise RuntimeError("detector exploded")

    monkeypatch.setattr(auto_calibration, "_find_and_solve", explode)
    layout = grid_layout(Display(*BOARD_SIZE, 1))
    with make_client(tmp_path, camera_frame(layout)) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        pattern = next_of(ws, "calibration_pattern")
        ws.send_json({"type": "calibration_pattern_shown", "run": pattern["run"]})
        status = final_status(ws)
        assert status["status"] == "error"
        assert "unexpected" in status["message"]
        assert next_of(ws, "calibration_pattern")["markers"] == []


def test_an_ack_for_an_older_run_does_not_count(tmp_path):
    layout = grid_layout(Display(*BOARD_SIZE, 1))
    with make_client(tmp_path, camera_frame(layout)) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        pattern = next_of(ws, "calibration_pattern")
        ws.send_json({"type": "calibration_pattern_shown", "run": pattern["run"] - 1})
        status = final_status(ws)
        assert status["status"] == "error"
        assert "board page" in status["message"]


def test_cancel_stops_auto_calibration_and_hides_the_pattern(tmp_path):
    layout = grid_layout(Display(*BOARD_SIZE, 1))
    with make_client(tmp_path, camera_frame(layout)) as client, board_page(client) as ws:
        ws.send_json({"type": "calibrate_auto"})
        next_of(ws, "calibration_pattern")
        ws.send_json({"type": "calibrate_cancel"})
        assert next_of(ws, "calibration_pattern")["markers"] == []
        status = final_status(ws)
        assert status["status"] == "none"
    assert load_calibration(tmp_path) is None
