import asyncio
import tempfile
from pathlib import Path

from hackcc_cv.config import Config
from hackcc_cv.state import ServerState


class Recorder:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


def make_state():
    state = ServerState(Config(camera_enabled=False, data_dir=Path(tempfile.mkdtemp())))
    recorder = Recorder()
    state.bus.add(recorder)
    return state, recorder


def test_status_changes_are_not_announced_while_a_calibration_runs():
    async def scenario():
        state, recorder = make_state()
        async with state.calibration_lock:
            await state.announce_calibration()
        return recorder.sent

    assert asyncio.run(scenario()) == []


def test_forced_announcements_still_go_out_during_a_calibration():
    async def scenario():
        state, recorder = make_state()
        async with state.calibration_lock:
            await state.announce_calibration(force=True)
        return recorder.sent

    sent = asyncio.run(scenario())
    assert [e["status"] for e in sent] == ["none"]


def test_status_is_announced_once_and_not_repeated():
    async def scenario():
        state, recorder = make_state()
        await state.announce_calibration()
        await state.announce_calibration()
        return recorder.sent

    assert len(asyncio.run(scenario())) == 1
