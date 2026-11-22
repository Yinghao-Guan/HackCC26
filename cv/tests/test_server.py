import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from hackcc_cv.config import Config
from hackcc_cv.server import create_app

ORIGIN = {"origin": "http://localhost:3000"}


def make_client(**overrides):
    config = Config(camera_enabled=False, **overrides)
    return TestClient(create_app(config), base_url="http://127.0.0.1:8765")


def test_health_reports_camera_off_and_no_clients():
    with make_client() as client:
        body = client.get("/health").json()
    assert body["ok"] is True
    assert body["camera"]["status"] == "off"
    assert body["clients"] == 0


def test_hello_is_acknowledged_with_the_display():
    with make_client() as client, client.websocket_connect("ws://127.0.0.1:8765/ws", headers=ORIGIN) as ws:
        assert ws.receive_json()["type"] == "camera"  # status on connect
        ws.send_json({"type": "hello", "width": 1707, "height": 1067, "dpr": 1.5})
        ack = ws.receive_json()
    assert ack == {"type": "hello_ack", "display": {"width": 1707, "height": 1067, "dpr": 1.5}}


def test_ping_gets_pong():
    with make_client() as client, client.websocket_connect("ws://127.0.0.1:8765/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_bad_message_gets_an_error_and_the_connection_stays_open():
    with make_client() as client, client.websocket_connect("ws://127.0.0.1:8765/ws", headers=ORIGIN) as ws:
        ws.receive_json()
        ws.send_text("garbage")
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"


def test_fake_pointer_events_reach_the_browser():
    with make_client(fake_pointer=True) as client, client.websocket_connect("ws://127.0.0.1:8765/ws", headers=ORIGIN) as ws:
        types = [ws.receive_json()["type"] for _ in range(5)]
    assert "pointer" in types


def test_connections_from_other_websites_are_refused():
    evil = {"origin": "https://evil.example"}
    with (
        make_client() as client,
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("ws://127.0.0.1:8765/ws", headers=evil) as ws,
    ):
        ws.receive_json()


def test_connections_without_an_origin_are_allowed_for_local_tools():
    with make_client() as client, client.websocket_connect("ws://127.0.0.1:8765/ws") as ws:
        assert ws.receive_json()["type"] == "camera"


def test_requests_for_other_host_names_are_refused():
    """A rebound domain pointing at 127.0.0.1 must not reach the camera preview."""
    with make_client() as client:
        response = client.get("/health", headers={"host": "evil.example"})
    assert response.status_code == 400


def test_root_redirects_to_the_debug_page():
    with make_client() as client:
        response = client.get("/", follow_redirects=False)
    assert response.status_code in (302, 307)
    assert response.headers["location"] == "/debug"


def test_debug_page_is_served():
    with make_client() as client:
        response = client.get("/debug")
    assert response.status_code == 200
    assert "WebSocket" in response.text


def test_preview_without_a_camera_is_unavailable():
    with make_client() as client:
        response = client.get("/preview.mjpg")
    assert response.status_code == 503
