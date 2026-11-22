import numpy as np
import pytest

from hackcc_cv.hand_pose import Hand, classify
from tests.hand_shapes import make_hand


@pytest.mark.parametrize(
    ("shape", "pose"),
    [
        ("open", "open"),
        ("fist", "fist"),
        ("point", "point"),
        ("pinch", "pinch"),
        ("pinch_open_fingers", "pinch"),
    ],
)
@pytest.mark.parametrize("angle", [0, 25, -40])
@pytest.mark.parametrize("size", [60, 150])
def test_poses_are_recognised_at_any_size_and_tilt(shape, pose, angle, size):
    assert classify(make_hand(shape, size=size, angle_deg=angle)).pose == pose


def test_only_a_pinch_counts_as_pinched():
    assert classify(make_hand("pinch")).pinched
    for shape in ("open", "fist", "point"):
        assert not classify(make_hand(shape)).pinched


def test_the_drawing_hand_is_never_a_gesture_pose():
    pose = classify(make_hand("point"))
    assert pose.pose == "point"
    assert not pose.pinched


def test_pinch_point_is_between_thumb_and_index_tips():
    hand = make_hand("pinch")
    pose = classify(hand)
    expected = (hand.landmarks[4] + hand.landmarks[8]) / 2
    assert np.allclose(pose.pinch_point, expected)


def test_palm_centre_and_size():
    pose = classify(make_hand("open", at=(400, 300), size=100))
    assert pose.size == pytest.approx(100, rel=0.01)
    assert 300 < pose.palm[0] < 420 and 180 < pose.palm[1] < 300


def test_pinch_release_needs_a_clearly_open_gap():
    """Hysteresis: a slightly opened pinch stays pinched, a clearly opened one does not."""
    hand = make_hand("pinch", size=100)
    landmarks = hand.landmarks.copy()
    landmarks[4] = landmarks[8] + np.array([-38.0, 0.0])  # gap 0.38 hand units
    loose = Hand(hand.label, landmarks, hand.score)
    assert classify(loose, was_pinched=True).pinched
    assert not classify(loose, was_pinched=False).pinched


def test_pose_reports_its_measurements_for_tuning():
    pinch = classify(make_hand("pinch", size=100))
    assert pinch.gap < 0.30
    fist = classify(make_hand("fist"))
    assert fist.curled == 4
    open_hand = classify(make_hand("open"))
    assert open_hand.curled == 0 and open_hand.extended == 4
    assert open_hand.landmarks.shape == (21, 2)


def test_hand_needs_21_points():
    with pytest.raises(ValueError):
        Hand("Right", np.zeros((5, 2)), 0.9)
