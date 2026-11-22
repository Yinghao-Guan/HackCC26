import threading
import time

import numpy as np

from hackcc_cv.camera import Frame
from hackcc_cv.tracking import TrackingLoop
from tests.hand_shapes import make_hand
from tests.test_camera import wait_for


class FakeCamera:
    """Hands out a new (blank) frame on every call."""

    def __init__(self):
        self.index = 0
        self.lock = threading.Lock()

    def latest(self):
        with self.lock:
            self.index += 1
            return Frame(image=np.zeros((720, 1280, 3), np.uint8), index=self.index, timestamp=time.time())


class ScriptedTracker:
    """Returns a pinch at a fixed spot for every frame, like a held pinch."""

    def __init__(self, hands_for_frame):
        self.hands_for_frame = hands_for_frame
        self.frames = 0
        self.closed = False

    def detect(self, image, timestamp_ms):
        self.frames += 1
        time.sleep(0.01)
        return self.hands_for_frame(self.frames)

    def close(self):
        self.closed = True


class Published:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def __call__(self, event):
        with self.lock:
            self.events.append(event)

    def of(self, kind):
        with self.lock:
            return [e for e in self.events if e["type"] == kind]


def run_loop(tracker, calibration=None, seconds=0.8, touching=lambda: False):
    published = Published()
    loop = TrackingLoop(
        FakeCamera(), lambda: tracker, published, lambda: calibration, touching=touching
    )
    loop.start()
    try:
        time.sleep(seconds)
        status = loop.status()
    finally:
        loop.stop()
    return published, status


def test_a_held_pinch_publishes_a_rotate_and_hand_positions():
    tracker = ScriptedTracker(lambda n: [make_hand("pinch", at=(500, 500))])
    published, status = run_loop(tracker)
    assert status["status"] == "ok"
    assert status["fps"] > 0
    assert published.of("rotate")[0]["phase"] == "start"
    hands = published.of("hands")
    assert hands and hands[-1]["hands"][0]["pose"] == "pinch"
    assert hands[-1]["calibrated"] is False
    # The camera-space skeleton and live measurements, for the Gesture Lab page.
    hand = hands[-1]["hands"][0]
    assert len(hand["camera_points"]) == 21
    assert hand["gap"] < 0.30
    assert hand["curled"] == 3 and hand["extended"] == 1  # the pinching index counts as out
    assert tracker.closed


def test_positions_go_through_the_calibration():
    class Doubling:
        def matrix(self):
            return np.diag([2.0, 2.0, 1.0])

    tracker = ScriptedTracker(lambda n: [make_hand("pinch", at=(500, 500))])
    published, _ = run_loop(tracker, calibration=Doubling())
    start = published.of("rotate")[0]
    point = make_hand("pinch", at=(500, 500)).landmarks[[4, 8]].mean(axis=0) * 2
    assert (start["x"], start["y"]) == (round(point[0], 1), round(point[1], 1))
    assert published.of("hands")[-1]["calibrated"] is True


def moving_pinch(n):
    """A pinch drifting right in the camera image (the person's left, for a camera facing them)."""
    return [make_hand("pinch", at=(400 + 4 * n, 500))]


def test_before_calibration_moves_are_mirrored_like_a_selfie_view():
    published, _ = run_loop(ScriptedTracker(moving_pinch), seconds=1.0)
    turned = sum(e["dx"] for e in published.of("rotate") if e["phase"] == "move")
    assert turned < -20  # camera-right is the person's left: the model turns left
    hand = published.of("hands")[-1]["hands"][0]
    camera_palm_x = np.mean([hand["camera_points"][i][0] for i in (0, 5, 9, 13, 17)])
    assert abs(hand["palm"][0] - (1280 - camera_palm_x)) < 1  # mirrored across the image
    assert published.of("hands")[-1]["calibrated"] is False


def test_after_calibration_moves_follow_the_board_not_the_mirror():
    class Identity:
        def matrix(self):
            return np.eye(3)

    published, _ = run_loop(ScriptedTracker(moving_pinch), calibration=Identity(), seconds=1.0)
    turned = sum(e["dx"] for e in published.of("rotate") if e["phase"] == "move")
    assert turned > 20


def test_touching_the_board_blocks_gestures():
    tracker = ScriptedTracker(lambda n: [make_hand("pinch", at=(500, 500))])
    published, _ = run_loop(tracker, touching=lambda: True)
    assert published.of("rotate") == []


def test_a_tracker_that_fails_to_load_is_reported():
    def broken():
        raise RuntimeError("model file is damaged")

    published = Published()
    loop = TrackingLoop(FakeCamera(), broken, published, lambda: None)
    loop.start()
    try:
        assert wait_for(lambda: loop.status()["status"] == "error")
        assert "damaged" in loop.status()["message"]
    finally:
        loop.stop()
    assert published.of("tracking")[-1]["status"] == "error"


def test_an_occasional_tracker_error_is_skipped_and_tracking_keeps_going():
    class Flaky(ScriptedTracker):
        def detect(self, image, timestamp_ms):
            hands = super().detect(image, timestamp_ms)
            if self.frames % 3 == 0:
                raise RuntimeError("one bad frame")
            return hands

    tracker = Flaky(lambda n: [make_hand("pinch", at=(500, 500))])
    published, status = run_loop(tracker)
    assert status["status"] == "ok"
    assert published.of("rotate")


def test_a_tracker_that_always_fails_is_reported_as_an_error():
    class Broken(ScriptedTracker):
        def detect(self, image, timestamp_ms):
            super().detect(image, timestamp_ms)
            raise RuntimeError("camera image unreadable")

    _, status = run_loop(Broken(lambda n: []), seconds=1.0)
    assert status["status"] == "error"
    assert "unreadable" in status["message"]


def test_events_carry_wall_clock_time():
    tracker = ScriptedTracker(lambda n: [make_hand("pinch", at=(500, 500))])
    published, _ = run_loop(tracker)
    start = published.of("rotate")[0]
    assert abs(start["t"] - time.time()) < 5


def test_hands_leaving_sends_one_empty_hands_event():
    tracker = ScriptedTracker(lambda n: [make_hand("open")] if n < 5 else [])
    published, _ = run_loop(tracker, seconds=0.6)
    hands = published.of("hands")
    assert hands[-1]["hands"] == []
    assert sum(1 for e in hands if e["hands"] == []) == 1
