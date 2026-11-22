"""The camera gets bumped: the drift monitor notices and recalibrates by itself."""

import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from hackcc_cv import auto_calibration, drift_monitor
from hackcc_cv.calibration import load_calibration
from hackcc_cv.camera import Camera
from hackcc_cv.config import Config, load_config
from hackcc_cv.events import Display
from hackcc_cv.markers import grid_layout
from hackcc_cv.server import create_app
from tests.synthetic import BOARD_SIZE, add_static_markers, camera_frame

WS_URL = "ws://127.0.0.1:8765/ws"


class SwitchableCapture:
    """A camera whose picture the test can change (to simulate a bump)."""

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


def scene(dx=0, dy=0):
    """Board with the marker grid, plus printed markers, as seen after moving the camera by dx, dy."""
    frame = add_static_markers(camera_frame(grid_layout(Display(*BOARD_SIZE, 1))))
    move = np.float64([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(frame, move, (frame.shape[1], frame.shape[0]), borderValue=(90, 90, 90))


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(drift_monitor, "CHECK_EVERY_SECONDS", 0.02)
    monkeypatch.setattr(auto_calibration, "FRAMES_PER_ATTEMPT", 3)
    monkeypatch.setattr(auto_calibration, "SETTLE_SECONDS", 0.02)
    monkeypatch.setattr(auto_calibration, "ACK_TIMEOUT_SECONDS", 1.0)


def make_client(tmp_path, capture, auto=True):
    config = Config(
        camera_enabled=True, warmup_seconds=0.0, gestures=False, data_dir=tmp_path, auto_recalibrate=auto
    )

    def factory(cfg, on_status):
        return Camera(cfg, capture_factory=lambda i, b: capture, on_status=on_status)

    return TestClient(create_app(config, camera_factory=factory), base_url="http://127.0.0.1:8765")


def pump(ws, until, limit=400):
    """Read events, confirming any calibration pattern, until `until(event)` is true."""
    seen = []
    for _ in range(limit):
        event = ws.receive_json()
        seen.append(event)
        if event["type"] == "calibration_pattern" and event["markers"]:
            ws.send_json({"type": "calibration_pattern_shown", "run": event["run"]})
        if until(event):
            return seen
    raise AssertionError(f"condition never met; last events: {[e['type'] for e in seen[-10:]]}")


def calibrated_ok(event):
    return event["type"] == "calibration" and event["status"] == "ok"


def board_page(client):
    ws = client.websocket_connect(WS_URL)
    return ws


def test_a_bumped_camera_is_noticed_and_recalibrated_automatically(tmp_path):
    capture = SwitchableCapture(scene())
    with make_client(tmp_path, capture) as client, client.websocket_connect(WS_URL) as ws:
        ws.send_json({"type": "hello", "width": BOARD_SIZE[0], "height": BOARD_SIZE[1], "dpr": 1})
        ws.send_json({"type": "calibrate_auto"})
        pump(ws, calibrated_ok)
        first = load_calibration(tmp_path)
        assert len(first.static()) == 4

        capture.image = scene(dx=12, dy=7)  # someone bumps the camera
        events = pump(ws, lambda e: calibrated_ok(e) and e.get("created_at") != first.created_at)

    drift = [e["status"] for e in events if e["type"] == "drift"]
    assert "moved" in drift
    stale = [e for e in events if e["type"] == "calibration" and e["status"] == "stale"]
    assert stale and "camera moved" in stale[0]["message"].lower()
    assert any(e["type"] == "calibration_pattern" and e["markers"] for e in events)
    second = load_calibration(tmp_path)
    # The new calibration accounts for the shift: the same board point is now 12, 7 px over.
    shift = second.static()[0].x - first.static()[0].x, second.static()[0].y - first.static()[0].y
    assert shift == pytest.approx((12, 7), abs=1.0)


def test_with_auto_recalibrate_off_a_bump_only_marks_the_calibration_stale(tmp_path):
    capture = SwitchableCapture(scene())
    with make_client(tmp_path, capture, auto=False) as client, client.websocket_connect(WS_URL) as ws:
        ws.send_json({"type": "hello", "width": BOARD_SIZE[0], "height": BOARD_SIZE[1], "dpr": 1})
        ws.send_json({"type": "calibrate_auto"})
        pump(ws, calibrated_ok)

        capture.image = scene(dx=12, dy=7)
        events = pump(ws, lambda e: e["type"] == "calibration" and e["status"] == "stale")
        assert not any(e["type"] == "calibration_pattern" and e["markers"] for e in events)

        capture.image = scene()  # moved back where it was
        pump(ws, calibrated_ok)


def blank_scene(dx=0, dy=0):
    """The board without the marker grid (so recalibration can't succeed), printed markers moved."""
    from tests.synthetic import camera_view

    frame = add_static_markers(camera_view(np.full((BOARD_SIZE[1], BOARD_SIZE[0]), 245, np.uint8)))
    move = np.float64([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(frame, move, (frame.shape[1], frame.shape[0]), borderValue=(90, 90, 90))


def test_failing_recalibration_gives_up_after_a_few_tries(tmp_path, monkeypatch):
    monkeypatch.setattr(drift_monitor, "RETRY_AFTER_FAILURE_SECONDS", 0.05)
    monkeypatch.setattr(auto_calibration, "ATTEMPTS", 1)
    capture = SwitchableCapture(scene())
    with make_client(tmp_path, capture) as client, client.websocket_connect(WS_URL) as ws:
        ws.send_json({"type": "hello", "width": BOARD_SIZE[0], "height": BOARD_SIZE[1], "dpr": 1})
        ws.send_json({"type": "calibrate_auto"})
        pump(ws, calibrated_ok)

        capture.image = blank_scene(dx=12, dy=7)  # moved, and the grid can't be found any more
        events = pump(
            ws, lambda e: e["type"] == "calibration" and "gave up" in e.get("message", "").lower()
        )
        tries = sum(1 for e in events if e["type"] == "calibration_pattern" and e["markers"])
        assert tries == drift_monitor.MAX_AUTO_TRIES
        time.sleep(0.6)  # long enough for several more retries if it hadn't stopped
        assert client.get("/health").json()["calibration"]["status"] == "stale"
        assert drift_monitor.MAX_AUTO_TRIES == 3


def test_auto_recalibrate_flag_and_environment_variable():
    assert load_config(env={}, argv=["--no-auto-recalibrate"]).auto_recalibrate is False
    assert load_config(env={"CV_AUTO_RECALIBRATE": "0"}, argv=[]).auto_recalibrate is False
    assert load_config(env={}, argv=[]).auto_recalibrate is True
