import json

import pytest

from hackcc_cv.events import (
    DEFAULT_DISPLAY,
    MAX_MESSAGE_CHARS,
    CancelCalibration,
    Display,
    Hello,
    ManualCalibration,
    MapPoint,
    MessageError,
    Ping,
    StartManualCalibration,
    calibration_probe_event,
    calibration_targets_event,
    camera_status_event,
    error_event,
    hello_ack_event,
    parse_client_message,
    pointer_event,
)


def test_pointer_event_matches_the_shared_contract():
    event = pointer_event(812.4, 440.1, True, t=1767000000.123)
    assert event == {
        "type": "pointer",
        "id": 0,
        "x": 812.4,
        "y": 440.1,
        "touching": True,
        "t": 1767000000.123,
    }


def test_pointer_event_fills_in_the_time():
    event = pointer_event(1, 2, False)
    assert isinstance(event["t"], float) and event["t"] > 0


def test_camera_status_event_reports_errors_loudly():
    event = camera_status_event("error", message="Camera 0 could not be opened.")
    assert event["type"] == "camera"
    assert event["status"] == "error"
    assert "could not be opened" in event["message"]


def test_camera_status_event_rejects_unknown_status():
    with pytest.raises(ValueError):
        camera_status_event("sleepy")


def test_hello_ack_echoes_the_display():
    event = hello_ack_event(Display(1707, 1067, 1.5))
    assert event == {
        "type": "hello_ack",
        "display": {"width": 1707, "height": 1067, "dpr": 1.5},
    }


def test_error_event_has_a_message():
    assert error_event("nope") == {"type": "error", "message": "nope"}


def test_parse_hello():
    message = parse_client_message(json.dumps({"type": "hello", "width": 1707, "height": 1067, "dpr": 1.5}))
    assert message == Hello(Display(1707, 1067, 1.5))


def test_parse_hello_defaults_dpr_to_one():
    message = parse_client_message(json.dumps({"type": "hello", "width": 800, "height": 600}))
    assert message == Hello(Display(800, 600, 1.0))


def test_parse_ping():
    assert parse_client_message('{"type": "ping"}') == Ping()


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        '{"no_type": 1}',
        '{"type": "teleport"}',
        '{"type": "hello", "width": 0, "height": 600}',
        '{"type": "hello", "width": 800, "height": 99999}',
        '{"type": "hello", "width": "800", "height": 600}',
        '{"type": "hello", "width": true, "height": 600}',
        '{"type": "hello", "width": 800, "height": 600, "dpr": 20}',
    ],
)
def test_bad_messages_raise_message_error(raw):
    with pytest.raises(MessageError):
        parse_client_message(raw)


def test_hello_role_defaults_to_board_and_accepts_operator():
    assert parse_client_message('{"type":"hello","width":800,"height":600}').role == "board"
    message = parse_client_message('{"type":"hello","width":800,"height":600,"role":"operator"}')
    assert message.role == "operator"


def test_hello_with_an_unknown_role_is_rejected():
    with pytest.raises(MessageError):
        parse_client_message('{"type":"hello","width":800,"height":600,"role":"boss"}')


def test_parse_manual_calibration():
    raw = json.dumps(
        {
            "type": "calibrate_manual",
            "camera_points": [[1, 2], [3, 4], [5, 6], [7, 8]],
            "camera_size": [1280, 720],
        }
    )
    message = parse_client_message(raw)
    assert message == ManualCalibration(((1, 2), (3, 4), (5, 6), (7, 8)), (1280, 720))


def test_parse_calibration_start_cancel_and_map_point():
    assert parse_client_message('{"type":"calibrate_manual_start"}') == StartManualCalibration()
    assert parse_client_message('{"type":"calibrate_cancel"}') == CancelCalibration()
    assert parse_client_message('{"type":"map_point","camera_point":[10.5,20]}') == MapPoint((10.5, 20))


@pytest.mark.parametrize(
    "raw",
    [
        '{"type":"calibrate_manual","camera_points":[[1,2],[3,4],[5,6]],"camera_size":[1280,720]}',
        '{"type":"calibrate_manual","camera_points":[[1,2],[3,4],[5,6],[7]],"camera_size":[1280,720]}',
        '{"type":"calibrate_manual","camera_points":[[1,2],[3,4],[5,6],[7,"8"]],"camera_size":[1280,720]}',
        '{"type":"calibrate_manual","camera_points":[[1,2],[3,4],[5,6],[7,8]],"camera_size":[0,720]}',
        '{"type":"calibrate_manual","camera_points":"nope","camera_size":[1280,720]}',
        '{"type":"map_point","camera_point":[1]}',
        '{"type":"map_point"}',
    ],
)
def test_bad_calibration_messages_are_rejected(raw):
    with pytest.raises(MessageError):
        parse_client_message(raw)


def test_calibration_targets_event():
    event = calibration_targets_event([(10.0, 20.0), (30.0, 20.0), (30.0, 40.0), (10.0, 40.0)])
    assert event == {
        "type": "calibration_targets",
        "targets": [
            {"id": 1, "x": 10.0, "y": 20.0},
            {"id": 2, "x": 30.0, "y": 20.0},
            {"id": 3, "x": 30.0, "y": 40.0},
            {"id": 4, "x": 10.0, "y": 40.0},
        ],
    }


def test_calibration_probe_event():
    event = calibration_probe_event((100.25, 50.5), (640, 360))
    assert event == {"type": "calibration_probe", "x": 100.25, "y": 50.5, "camera_x": 640, "camera_y": 360}


def test_oversized_messages_are_rejected_before_parsing():
    with pytest.raises(MessageError):
        parse_client_message(" " * (MAX_MESSAGE_CHARS + 1))


def test_default_display_is_sane():
    assert DEFAULT_DISPLAY.width > 0 and DEFAULT_DISPLAY.height > 0
