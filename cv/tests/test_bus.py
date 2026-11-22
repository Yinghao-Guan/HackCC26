import asyncio
import threading

from hackcc_cv.bus import Bus


class FakeClient:
    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    async def send_json(self, data):
        if self.fail:
            raise RuntimeError("connection closed")
        self.sent.append(data)


def test_broadcast_reaches_every_client():
    async def scenario():
        bus = Bus()
        a, b = FakeClient(), FakeClient()
        bus.add(a)
        bus.add(b)
        await bus.broadcast({"type": "x"})
        return a, b, bus

    a, b, bus = asyncio.run(scenario())
    assert a.sent == [{"type": "x"}]
    assert b.sent == [{"type": "x"}]
    assert bus.client_count == 2


def test_a_broken_client_is_dropped_and_others_still_receive():
    async def scenario():
        bus = Bus()
        good, broken = FakeClient(), FakeClient(fail=True)
        bus.add(good)
        bus.add(broken)
        await bus.broadcast({"type": "x"})
        return good, bus

    good, bus = asyncio.run(scenario())
    assert good.sent == [{"type": "x"}]
    assert bus.client_count == 1


class StuckClient:
    async def send_json(self, data):
        await asyncio.sleep(60)


def test_a_stuck_client_is_dropped_without_holding_up_the_rest():
    async def scenario():
        bus = Bus(send_timeout=0.05)
        good, stuck = FakeClient(), StuckClient()
        bus.add(good)
        bus.add(stuck)
        await asyncio.wait_for(bus.broadcast({"type": "x"}), timeout=1.0)
        return good, bus

    good, bus = asyncio.run(scenario())
    assert good.sent == [{"type": "x"}]
    assert bus.client_count == 1


def test_publish_threadsafe_after_the_loop_closed_is_ignored():
    bus = Bus()
    loop = asyncio.new_event_loop()
    bus.attach_loop(loop)
    loop.close()
    bus.publish_threadsafe({"type": "late"})  # must not raise


def test_remove_is_safe_for_unknown_clients():
    bus = Bus()
    bus.remove(FakeClient())
    assert bus.client_count == 0


def test_publish_threadsafe_delivers_from_another_thread():
    async def scenario():
        bus = Bus()
        bus.attach_loop(asyncio.get_running_loop())
        client = FakeClient()
        bus.add(client)
        thread = threading.Thread(target=bus.publish_threadsafe, args=({"type": "from-thread"},))
        thread.start()
        thread.join()
        for _ in range(50):
            if client.sent:
                break
            await asyncio.sleep(0.01)
        return client

    client = asyncio.run(scenario())
    assert client.sent == [{"type": "from-thread"}]


def test_publish_threadsafe_without_a_loop_is_ignored():
    bus = Bus()
    bus.publish_threadsafe({"type": "nobody-listening"})  # must not raise
