import json

import pytest

from hackcc_cv.events import (
    DEFAULT_DISPLAY,
    MAX_MESSAGE_CHARS,
    Display,
    Hello,
    MessageError,
    Ping,
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


def test_oversized_messages_are_rejected_before_parsing():
    with pytest.raises(MessageError):
        parse_client_message(" " * (MAX_MESSAGE_CHARS + 1))


def test_default_display_is_sane():
    assert DEFAULT_DISPLAY.width > 0 and DEFAULT_DISPLAY.height > 0
