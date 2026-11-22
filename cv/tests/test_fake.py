import asyncio

from hackcc_cv.events import Display
from hackcc_cv.fake import (
    CYCLE_SECONDS,
    TOUCH_SECONDS,
    fake_pointer_at,
    run_fake_pointer,
)


def test_fake_pointer_stays_inside_the_display():
    display = Display(1707, 1067, 1.5)
    for step in range(400):
        x, y, _ = fake_pointer_at(step * 0.05, display)
        assert 0 <= x <= display.width
        assert 0 <= y <= display.height


def test_fake_pointer_touches_then_lifts_each_cycle():
    display = Display(1000, 500, 1)
    assert fake_pointer_at(0.1, display)[2] is True
    assert fake_pointer_at(TOUCH_SECONDS + 0.01, display)[2] is False
    assert fake_pointer_at(CYCLE_SECONDS + 0.1, display)[2] is True


def test_fake_pointer_is_deterministic():
    display = Display(1000, 500, 1)
    assert fake_pointer_at(1.234, display) == fake_pointer_at(1.234, display)


def test_fake_pointer_moves():
    display = Display(1000, 500, 1)
    assert fake_pointer_at(0.0, display)[:2] != fake_pointer_at(0.5, display)[:2]


def test_run_fake_pointer_publishes_pointer_events_until_cancelled():
    published = []

    async def publish(event):
        published.append(event)

    async def scenario():
        task = asyncio.create_task(
            run_fake_pointer(publish, lambda: Display(800, 600, 1), hz=200)
        )
        await asyncio.sleep(0.1)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(scenario())
    assert len(published) >= 3
    assert all(event["type"] == "pointer" for event in published)
    assert all(0 <= event["x"] <= 800 for event in published)
