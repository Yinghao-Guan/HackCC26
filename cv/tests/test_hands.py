from types import SimpleNamespace

import numpy as np
import pytest

from hackcc_cv.hands import HandTracker
from hackcc_cv.models import HAND_MODEL_PATH


def landmark(x, y):
    return SimpleNamespace(x=x, y=y, z=0.0)


class FakeLandmarker:
    """Stands in for MediaPipe: one right hand with every point at (0.25, 0.5)."""

    def __init__(self):
        self.timestamps = []

    def detect_for_video(self, image, timestamp_ms):
        self.timestamps.append(timestamp_ms)
        hand = [landmark(0.25, 0.5)] * 21
        label = SimpleNamespace(category_name="Right", score=0.93)
        return SimpleNamespace(hand_landmarks=[hand], handedness=[[label]])

    def close(self):
        pass


def test_landmarks_come_back_in_camera_pixels_with_the_hand_label():
    fake = FakeLandmarker()
    tracker = HandTracker(landmarker=fake)
    hands = tracker.detect(np.zeros((720, 1280, 3), np.uint8), timestamp_ms=1000)
    assert len(hands) == 1
    assert hands[0].label == "Right"
    assert hands[0].score == pytest.approx(0.93)
    assert np.allclose(hands[0].landmarks[0], (320, 360))


def test_timestamps_always_increase_even_if_the_clock_does_not():
    fake = FakeLandmarker()
    tracker = HandTracker(landmarker=fake)
    image = np.zeros((10, 10, 3), np.uint8)
    for stamp in (1000, 1000, 990, 1005):
        tracker.detect(image, timestamp_ms=stamp)
    assert fake.timestamps == sorted(set(fake.timestamps))
    assert len(fake.timestamps) == 4


@pytest.mark.skipif(not HAND_MODEL_PATH.exists(), reason="hand model not downloaded")
def test_the_real_model_runs_and_finds_no_hands_in_an_empty_image():
    tracker = HandTracker.from_model(HAND_MODEL_PATH)
    try:
        assert tracker.detect(np.full((480, 640, 3), 200, np.uint8), timestamp_ms=1) == []
    finally:
        tracker.close()
