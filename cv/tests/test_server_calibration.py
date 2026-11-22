"""Manual four-corner calibration over the WebSocket."""

from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from hackcc_cv.calibration import load_calibration, manual_targets, save_calibration
from hackcc_cv.config import Config
from hackcc_cv.events import Display
from hackcc_cv.homography import map_point
from hackcc_cv.server import create_app
from tests.test_calibration import make_calibration

WS_URL = "ws://127.0.0.1:8765/ws"
CAMERA_QUAD = [[300, 120], [1100, 180], [1040, 640], [260, 600]]
CAMERA_SIZE = [1280, 720]


@pytest.fixture
def client(tmp_path):
    config = Config(camera_enabled=False, data_dir=tmp_path)
    with TestClient(create_app(config), base_url="http://127.0.0.1:8765") as test_client:
        yield test_client


@contextmanager
def connect(client, width=1000, height=500, role="board"):
    """Open the bus, read the two status messages, say hello. Yields (ws, calibration status)."""
    with client.websocket_connect(WS_URL) as ws:
        assert ws.receive_json()["type"] == "camera"
        status = ws.receive_json()
        assert status["type"] == "calibration"
        ws.send_json({"type": "hello", "width": width, "height": height, "dpr": 1, "role": role})
        assert ws.receive_json()["type"] == "hello_ack"
        yield ws, status


def next_of(ws, kind):
    for _ in range(10):
        event = ws.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"no {kind} event")


def test_new_connections_are_told_there_is_no_calibration_yet(client):
    with connect(client) as (_, status):
        assert status["status"] == "none"


def test_starting_manual_calibration_shows_four_targets_on_the_board(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual_start"})
        event = next_of(ws, "calibration_targets")
        expected = manual_targets(Display(1000, 500, 1))
        assert [(t["x"], t["y"]) for t in event["targets"]] == expected
        assert [t["id"] for t in event["targets"]] == [1, 2, 3, 4]


def test_clicking_the_four_targets_calibrates_saves_and_hides_the_targets(client, tmp_path):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual_start"})
        next_of(ws, "calibration_targets")
        ws.send_json({"type": "calibrate_manual", "camera_points": CAMERA_QUAD, "camera_size": CAMERA_SIZE})

        status = next_of(ws, "calibration")
        assert status["status"] == "ok"
        assert status["method"] == "manual"
        assert status["reproj_error_px"] < 0.5
        assert next_of(ws, "calibration_targets")["targets"] == []

        saved = load_calibration(tmp_path)
        assert saved is not None and saved.board_size == (1000, 500)
        corner = map_point(saved.matrix(), *CAMERA_QUAD[0])
        assert corner == pytest.approx(manual_targets(Display(1000, 500, 1))[0], abs=1e-6)


def test_clicks_in_the_wrong_order_are_refused_and_nothing_is_saved(client, tmp_path):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual_start"})
        next_of(ws, "calibration_targets")
        reversed_quad = list(reversed(CAMERA_QUAD))
        ws.send_json({"type": "calibrate_manual", "camera_points": reversed_quad, "camera_size": CAMERA_SIZE})
        status = next_of(ws, "calibration")
        assert status["status"] == "error"
        assert "order" in status["message"]
        assert load_calibration(tmp_path) is None


def test_map_point_needs_a_calibration_first(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "map_point", "camera_point": [500, 300]})
        assert "calibrat" in next_of(ws, "error")["message"].lower()


def test_map_point_puts_a_probe_where_the_camera_point_lands_on_the_board(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual", "camera_points": CAMERA_QUAD, "camera_size": CAMERA_SIZE})
        next_of(ws, "calibration")
        ws.send_json({"type": "map_point", "camera_point": CAMERA_QUAD[2]})
        probe = next_of(ws, "calibration_probe")
        bottom_right = manual_targets(Display(1000, 500, 1))[2]
        assert (probe["x"], probe["y"]) == pytest.approx(bottom_right, abs=0.01)
        assert (probe["camera_x"], probe["camera_y"]) == (1040, 640)


def test_a_point_that_maps_to_infinity_gets_an_error_and_nobody_is_dropped(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual", "camera_points": CAMERA_QUAD, "camera_size": CAMERA_SIZE})
        next_of(ws, "calibration")
        # Far outside the image, on the line the perspective sends to infinity.
        calibration = client.get("/health").json()["calibration"]
        assert calibration["status"] == "ok"
        ws.send_json({"type": "map_point", "camera_point": [16000, -16000]})
        event = next_of(ws, "error")
        assert "outside" in event["message"]
        ws.send_json({"type": "ping"})
        assert next_of(ws, "pong")["type"] == "pong"
        assert client.get("/health").json()["clients"] == 1


def test_a_failed_save_is_reported_and_not_hidden_by_ok(tmp_path):
    blocked = tmp_path / "not-a-folder"
    blocked.write_text("x", encoding="utf-8")
    config = Config(camera_enabled=False, data_dir=blocked)
    with (
        TestClient(create_app(config), base_url="http://127.0.0.1:8765") as test_client,
        connect(test_client) as (ws, _),
    ):
        ws.send_json({"type": "calibrate_manual", "camera_points": CAMERA_QUAD, "camera_size": CAMERA_SIZE})
        status = next_of(ws, "calibration")
        assert status["status"] == "ok"
        assert "could not be saved" in status["message"]
        assert "could not be saved" in test_client.get("/health").json()["calibration"]["message"]


def test_the_board_changing_size_mid_calibration_is_refused(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual_start"})
        next_of(ws, "calibration_targets")
        ws.send_json({"type": "hello", "width": 800, "height": 600, "dpr": 1})
        next_of(ws, "hello_ack")
        ws.send_json({"type": "calibrate_manual", "camera_points": CAMERA_QUAD, "camera_size": CAMERA_SIZE})
        status = next_of(ws, "calibration")
        assert status["status"] == "error"
        assert "Show targets" in status["message"]


def test_cancel_hides_the_targets(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual_start"})
        next_of(ws, "calibration_targets")
        ws.send_json({"type": "calibrate_cancel"})
        assert next_of(ws, "calibration_targets")["targets"] == []


def test_a_saved_calibration_is_loaded_at_startup(tmp_path):
    save_calibration(make_calibration(board_size=(1000.0, 500.0)), tmp_path)
    config = Config(camera_enabled=False, data_dir=tmp_path)
    with (
        TestClient(create_app(config), base_url="http://127.0.0.1:8765") as test_client,
        connect(test_client) as (ws, status),
    ):
        # Before the board says how big it is, the saved size can't be confirmed.
        assert status["status"] == "stale"
        assert status["method"] == "manual"
        # Once the 1000x500 board page says hello, the saved calibration fits.
        assert next_of(ws, "calibration")["status"] == "ok"
        assert test_client.get("/health").json()["calibration"]["status"] == "ok"


def test_resizing_the_board_page_marks_the_calibration_stale(client):
    with connect(client) as (ws, _):
        ws.send_json({"type": "calibrate_manual", "camera_points": CAMERA_QUAD, "camera_size": CAMERA_SIZE})
        assert next_of(ws, "calibration")["status"] == "ok"
        ws.send_json({"type": "hello", "width": 800, "height": 600, "dpr": 1})
        status = next_of(ws, "calibration")
        assert status["status"] == "stale"
        assert "board" in status["message"]


def test_an_operator_page_does_not_change_the_board_size(client):
    with (
        connect(client, width=1000, height=500),
        connect(client, width=640, height=400, role="operator"),
    ):
        assert client.get("/health").json()["display"]["width"] == 1000


def test_calibrate_page_is_served(client):
    response = client.get("/calibrate")
    assert response.status_code == 200
    assert "calibrate_manual" in response.text
