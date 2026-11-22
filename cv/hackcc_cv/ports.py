"""Starting cleanly: a clear message when the port is taken, and less Windows noise."""

from __future__ import annotations

import asyncio
import logging
import socket
import sys
from typing import Any

log = logging.getLogger(__name__)


def port_in_use(host: str, port: int) -> bool:
    """True if another program (often an earlier copy of this service) owns the port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if sys.platform == "win32":
            # Without this, Windows may let a second program share a port that is in use.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            probe.bind((host, port))
        except OSError:
            return True
    return False


def quiet_connection_resets(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
    """Event-loop error handler that drops "connection reset by peer".

    On Windows, a browser tab closing its connection makes asyncio print a long
    ConnectionResetError (WinError 10054) traceback. It is harmless, so log it quietly;
    report everything else as usual.
    """
    if isinstance(context.get("exception"), ConnectionResetError):
        log.debug("A browser closed its connection: %s", context.get("message"))
        return
    loop.default_exception_handler(context)
