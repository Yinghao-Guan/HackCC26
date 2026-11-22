import asyncio
import logging
import socket

from hackcc_cv.ports import port_in_use, quiet_connection_resets


def test_a_port_another_program_listens_on_is_in_use():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as holder:
        holder.bind(("127.0.0.1", 0))
        holder.listen()
        port = holder.getsockname()[1]
        assert port_in_use("127.0.0.1", port)


def test_a_free_port_is_not_in_use():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    assert not port_in_use("127.0.0.1", port)


def test_connection_resets_are_not_logged_as_errors(caplog):
    loop = asyncio.new_event_loop()
    try:
        with caplog.at_level(logging.ERROR):
            quiet_connection_resets(loop, {"message": "x", "exception": ConnectionResetError(10054)})
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
    finally:
        loop.close()


def test_other_loop_errors_are_still_reported(caplog):
    loop = asyncio.new_event_loop()
    try:
        with caplog.at_level(logging.ERROR):
            quiet_connection_resets(loop, {"message": "boom", "exception": ValueError("real bug")})
        assert any("boom" in r.getMessage() for r in caplog.records)
    finally:
        loop.close()
