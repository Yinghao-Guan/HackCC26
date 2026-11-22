"""The event bus: every connected browser gets every event.

The camera works in its own thread, so it publishes with `publish_threadsafe`;
code already running in the server's event loop awaits `broadcast`.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

log = logging.getLogger(__name__)


class Client(Protocol):
    async def send_json(self, data: Any) -> None: ...


SEND_TIMEOUT_SECONDS = 1.0


class Bus:
    def __init__(self, send_timeout: float = SEND_TIMEOUT_SECONDS) -> None:
        self._clients: set[Client] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self.send_timeout = send_timeout

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def add(self, client: Client) -> None:
        self._clients.add(client)

    def remove(self, client: Client) -> None:
        self._clients.discard(client)

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the server's event loop so other threads can publish into it."""
        self._loop = loop

    async def broadcast(self, event: dict[str, Any]) -> None:
        """Send to every client. A client that errors or is too slow is dropped,
        so one stuck browser tab never holds up the others."""
        clients = list(self._clients)
        results = await asyncio.gather(
            *(asyncio.wait_for(client.send_json(event), self.send_timeout) for client in clients),
            return_exceptions=True,
        )
        for client, result in zip(clients, results):
            if isinstance(result, BaseException):
                log.info("Dropping a client that could not keep up: %r", result)
                self.remove(client)

    def publish_threadsafe(self, event: dict[str, Any]) -> None:
        """Send an event from any thread. Ignored if the server is not running."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self.broadcast(event), loop)
        except RuntimeError:
            pass  # the loop closed between the check and the call (shutting down)
