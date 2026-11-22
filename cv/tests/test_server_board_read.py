"""Reading physical writing over the WebSocket: flash, capture, find writing, publish."""

from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from hackcc_cv import board_reader
from hackcc_cv.calibration import Calibration, save_calibration
from hackcc_cv.camera import Camera
from hackcc_cv.config import Config
from hackcc_cv.server import create_app
from tests.synthetic import (
    BOARD_SIZE,
    CAMERA_SIZE,
    camera_view,
    render_writing_board,
    true_camera_to_board,
)
from tests.test_server_auto_calibration import ImageCapture

WS_URL = "ws://127.0.0.1:8765/ws"


@pytest.fixture(autouse=True)
def fast_timings(monkeypatch):
    monkeypatch.setattr(board_reader, "SETTLE_SECONDS", 0.05)
    monkeypatch.setattr(board_reader, "ACK_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(board_reader, "FRAMES", 3)


def make_client(tmp_path, calibrated=True):
    if calibrated:
        save_calibration(
            Calibration.from_matrix(
                true_camera_to_board(), method="aruco", camera_size=CAMERA_SIZE,
                board_size=(float(BOARD_SIZE[0]), float(BOARD_SIZE[1])),
                reprojection_error_px=0.3, points=48,
            ),
            tmp_path,
        )
    image = camera_view(render_writing_board())
    config = Config(camera_enabled=True, warmup_seconds=0.0, gestures=False, data_dir=tmp_path)

    def factory(cfg, on_status):
        return Camera(cfg, capture_factory=lambda i, b: ImageCapture(image), on_status=on_status)

    return TestClient(create_app(config, camera_factory=factory), base_url="http://127.0.0.1:8765")


@contextmanager
def board_page(client):
    with client.websocket_connect(WS_URL) as ws:
        ws.send_json({"type": "hello", "width": BOARD_SIZE[0], "height": BOARD_SIZE[1], "dpr": 1})
        for _ in range(20):
            if ws.receive_json()["type"] == "hello_ack":
                break
        yield ws


def until(ws, kind, limit=60):
    for _ in range(limit):
        event = ws.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"no {kind} event")


def until_done(ws, limit=80):
    """Every event up to and including the finished board_read status."""
    seen = []
    for _ in range(limit):
        event = ws.receive_json()
        seen.append(event)
        if event["type"] == "board_read" and event["status"] != "reading":
            return seen
    raise AssertionError("board reading never finished")


def of(events, kind):
    return [e for e in events if e["type"] == kind]


def test_reading_the_whole_board_finds_the_three_pieces_of_writing(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board"})
        flash = until(ws, "flash")
        assert flash["color"] == "white"
        assert flash["bbox"] == [0.0, 0.0, float(BOARD_SIZE[0]), float(BOARD_SIZE[1])]
        ws.send_json({"type": "flash_shown", "run": flash["run"]})
        events = until_done(ws)

    status = events[-1]
    assert status["status"] == "ok", status["message"]
    regions = of(events, "content_regions")[-1]["regions"]
    assert len(regions) == 3
    assert all(r["kind"] == "physical" and len(r["bbox"]) == 4 for r in regions)
    capture = of(events, "content_capture")[-1]
    assert capture["image"].startswith("data:image/png;base64,")
    assert capture["regions"] == regions
    assert of(events, "flash")[-1]["bbox"] is None  # the white is gone again


def test_reading_part_of_the_board(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board", "bbox": [0, 0, 700, BOARD_SIZE[1]]})
        flash = until(ws, "flash")
        assert flash["bbox"] == [0.0, 0.0, 720.0, float(BOARD_SIZE[1])]  # 20 px margin, cut to the board
        ws.send_json({"type": "flash_shown", "run": flash["run"]})
        events = until_done(ws)
    assert of(events, "content_capture")[-1]["bbox"] == [0.0, 0.0, 700.0, float(BOARD_SIZE[1])]
    assert len(of(events, "content_regions")[-1]["regions"]) == 2


def test_an_area_partly_off_the_board_is_clipped_to_the_board(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board", "bbox": [-200, -50, 16000, 16000]})
        flash = until(ws, "flash")
        x, y, w, h = flash["bbox"]
        assert x >= 0 and y >= 0 and x + w <= BOARD_SIZE[0] and y + h <= BOARD_SIZE[1]
        ws.send_json({"type": "flash_shown", "run": flash["run"]})
        events = until_done(ws)
    assert events[-1]["status"] == "ok"
    capture = of(events, "content_capture")[-1]
    assert capture["bbox"] == [0.0, 0.0, float(BOARD_SIZE[0]), float(BOARD_SIZE[1])]
    assert len(capture["regions"]) == 3


def test_an_area_entirely_off_the_board_is_refused(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board", "bbox": [5000, 5000, 100, 100]})
        status = until_done(ws)[-1]
    assert status["status"] == "error"
    assert "outside the board" in status["message"]


def test_the_white_reaches_a_little_past_a_small_area(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board", "bbox": [100, 100, 300, 200]})
        flash = until(ws, "flash")
        ws.send_json({"type": "flash_shown", "run": flash["run"]})
        events = until_done(ws)
    x, y, w, h = flash["bbox"]
    assert x < 100 and y < 100 and x + w > 400 and y + h > 300  # covers a margin around it
    assert of(events, "content_capture")[-1]["bbox"] == [100.0, 100.0, 300.0, 200.0]


def test_reading_needs_a_calibration(tmp_path):
    with make_client(tmp_path, calibrated=False) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board"})
        status = until_done(ws)[-1]
    assert status["status"] == "error"
    assert "calibrat" in status["message"].lower()


def test_no_board_page_showing_the_white_is_an_error(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board"})
        until(ws, "flash")  # never confirm it
        events = until_done(ws)
    assert events[-1]["status"] == "error"
    assert "board page" in events[-1]["message"]
    assert of(events, "flash")[-1]["bbox"] is None


def test_a_bad_area_is_refused(tmp_path):
    with make_client(tmp_path) as client, board_page(client) as ws:
        ws.send_json({"type": "read_board", "bbox": [0, 0, -5, 10]})
        assert "bbox" in until(ws, "error")["message"]
