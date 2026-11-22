"""A made-up finger that writes a figure eight, for building the UI without a camera.

Each cycle it touches the board for TOUCH_SECONDS (a stroke), then lifts.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable
from typing import Any

from .events import Display, pointer_event

CYCLE_SECONDS = 4.0
TOUCH_SECONDS = 3.4


def fake_pointer_at(elapsed: float, display: Display) -> tuple[float, float, bool]:
    """Where the fake finger is after `elapsed` seconds, and whether it touches."""
    phase = 2 * math.pi * (elapsed % CYCLE_SECONDS) / CYCLE_SECONDS
    x = display.width * (0.5 + 0.3 * math.sin(phase))
    y = display.height * (0.5 + 0.25 * math.sin(2 * phase))
    touching = (elapsed % CYCLE_SECONDS) < TOUCH_SECONDS
    return x, y, touching


async def run_fake_pointer(
    publish: Callable[[dict[str, Any]], Awaitable[None]],
    get_display: Callable[[], Display],
    hz: float = 30.0,
) -> None:
    """Publish fake pointer events until cancelled."""
    loop = asyncio.get_running_loop()
    start = loop.time()
    period = 1.0 / hz
    while True:
        x, y, touching = fake_pointer_at(loop.time() - start, get_display())
        await publish(pointer_event(round(x, 1), round(y, 1), touching))
        await asyncio.sleep(period)
