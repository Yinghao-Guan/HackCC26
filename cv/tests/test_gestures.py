"""The five agreed gestures, driven by synthetic hands over time (30 frames a second)."""

from hackcc_cv.gestures import GestureEngine
from tests.hand_shapes import make_hand

FPS = 30


class Script:
    """Feeds an engine frame by frame and collects every event it emits."""

    def __init__(self, engine=None):
        self.engine = engine or GestureEngine()
        self.t = 100.0
        self.events = []

    def hold(self, seconds, hands_at, touching=False):
        """`hands_at(progress 0..1)` returns the hands for each frame."""
        frames = max(1, round(seconds * FPS))
        for i in range(frames):
            hands = hands_at(i / max(1, frames - 1))
            self.events += self.engine.update(hands, self.t, touching=touching)
            self.t += 1 / FPS
        return self

    def still(self, seconds, *hands, touching=False):
        return self.hold(seconds, lambda _: list(hands), touching)

    def named(self, kind, phase=None):
        return [
            e for e in self.events
            if e["type"] == kind and (phase is None or e.get("phase") == phase)
        ]

    def gestures(self, name):
        return [e for e in self.events if e["type"] == "gesture" and e["name"] == name]


def pinch(at=(640, 500), label="Right"):
    return make_hand("pinch", at=at, label=label)


def open_hand(at=(640, 500), label="Right"):
    return make_hand("open", at=at, label=label)


# 1. Pen / eraser: thumb + index double tap in the air -------------------------


def test_double_tap_toggles_the_tool_once():
    s = Script().still(0.3, open_hand())
    s.still(0.15, pinch()).still(0.15, open_hand()).still(0.15, pinch()).still(0.4, open_hand())
    assert len(s.gestures("double_tap")) == 1
    assert not s.named("rotate")


def test_a_single_tap_does_nothing():
    s = Script().still(0.3, open_hand()).still(0.15, pinch()).still(1.0, open_hand())
    assert s.gestures("double_tap") == []


def test_two_taps_far_apart_are_not_a_double_tap():
    s = Script().still(0.15, pinch()).still(0.8, open_hand()).still(0.15, pinch()).still(0.4, open_hand())
    assert s.gestures("double_tap") == []


def test_three_quick_taps_make_one_double_tap():
    s = Script()
    for _ in range(3):
        s.still(0.15, pinch()).still(0.15, open_hand())
    s.still(0.5, open_hand())
    assert len(s.gestures("double_tap")) == 1


# 2. Move the board: fist, move, open --------------------------------------------


def test_fist_moves_the_board_until_the_hand_opens():
    s = Script().still(0.3, open_hand())
    s.hold(1.0, lambda p: [make_hand("fist", at=(640, 400 + 90 * p))])
    s.still(0.5, open_hand(at=(640, 490)))
    assert len(s.named("pan", "start")) == 1
    assert len(s.named("pan", "end")) == 1
    moved = sum(e["dy"] for e in s.named("pan", "move"))
    assert 70 < moved <= 90  # the move after the fist was confirmed
    assert abs(sum(e["dx"] for e in s.named("pan", "move"))) < 1


def test_a_brief_fist_flicker_does_not_end_the_move():
    s = Script().still(0.6, make_hand("fist"))
    s.still(0.05, open_hand())  # 1-2 frames misread
    s.still(0.5, make_hand("fist"))
    assert len(s.named("pan", "start")) == 1
    assert s.named("pan", "end") == []


# 3. Rotate 3D: pinch and hold, move ---------------------------------------------


def test_pinch_and_hold_rotates_and_is_not_a_tap():
    s = Script().still(0.3, open_hand())
    s.still(0.6, pinch(at=(500, 500)))
    s.hold(1.0, lambda p: [pinch(at=(500 + 120 * p, 500))])
    s.still(0.3, open_hand(at=(620, 500)))
    assert len(s.named("rotate", "start")) == 1
    assert len(s.named("rotate", "end")) == 1
    assert 100 < sum(e["dx"] for e in s.named("rotate", "move")) <= 121
    assert s.gestures("double_tap") == []


def test_rotate_start_says_where_the_pinch_is():
    s = Script().still(0.8, pinch(at=(500, 500)))
    start = s.named("rotate", "start")[0]
    point = make_hand("pinch", at=(500, 500)).landmarks[[4, 8]].mean(axis=0)
    assert (start["x"], start["y"]) == (round(point[0], 1), round(point[1], 1))


# 4. Zoom: pinch with both hands, apart / together --------------------------------


def two_pinches(gap):
    return [pinch(at=(640 - gap / 2, 500), label="Left"), pinch(at=(640 + gap / 2, 500), label="Right")]


def test_two_hand_pinch_zooms_in_when_hands_move_apart():
    s = Script().hold(1.0, lambda p: two_pinches(300 + 150 * p))
    s.still(0.3, open_hand(at=(400, 500), label="Left"), open_hand(at=(880, 500)))
    assert len(s.named("zoom", "start")) == 1
    assert len(s.named("zoom", "end")) == 1
    assert 1.45 < s.named("zoom", "move")[-1]["scale"] < 1.55
    assert s.named("rotate") == []
    assert s.gestures("double_tap") == []


def test_two_hand_pinch_zooms_out_when_hands_come_together():
    s = Script().hold(1.0, lambda p: two_pinches(400 - 200 * p))
    assert 0.45 < s.named("zoom", "move")[-1]["scale"] < 0.55


def test_a_second_hand_pinching_turns_a_rotate_into_a_zoom():
    s = Script().still(0.8, pinch(at=(500, 500), label="Left"))
    assert len(s.named("rotate", "start")) == 1
    s.hold(0.5, lambda p: [pinch(at=(500, 500), label="Left"), pinch(at=(800 + 60 * p, 500))])
    assert len(s.named("rotate", "end")) == 1
    assert len(s.named("zoom", "start")) == 1


# 5. Reset: both hands open, still for 2 seconds ------------------------------------


def two_open():
    return [open_hand(at=(400, 500), label="Left"), open_hand(at=(880, 500))]


def test_two_open_palms_for_two_seconds_reset_once_with_a_countdown():
    s = Script().still(2.6, *two_open())
    assert len(s.gestures("reset")) == 1
    progress = [e["progress"] for e in s.named("reset_progress")]
    assert progress == sorted(progress)
    assert progress[-1] == 1.0
    assert len(progress) >= 10


def test_lowering_the_hands_early_cancels_the_reset():
    s = Script().still(1.2, *two_open()).still(1.5)
    assert s.gestures("reset") == []
    assert s.named("reset_progress")[-1]["progress"] == 0.0


def test_one_open_palm_does_not_reset():
    s = Script().still(3.0, open_hand())
    assert s.gestures("reset") == []
    assert s.named("reset_progress") == []


def test_moving_open_hands_restarts_the_countdown():
    s = Script().still(1.5, *two_open())
    s.hold(0.2, lambda p: [open_hand(at=(400, 500 - 150 * p), label="Left"), open_hand(at=(880, 500))])
    s.still(1.0, open_hand(at=(400, 350), label="Left"), open_hand(at=(880, 500)))
    assert s.gestures("reset") == []


# Safety: drawing never triggers anything -------------------------------------------


def test_the_drawing_hand_never_triggers_a_gesture():
    s = Script().hold(2.0, lambda p: [make_hand("point", at=(400 + 300 * p, 500))])
    assert s.events == []


def test_nothing_happens_while_the_finger_touches_the_board():
    s = Script()
    for _ in range(2):
        s.still(0.15, pinch(), touching=True).still(0.15, open_hand(), touching=True)
    s.still(1.0, make_hand("fist"), touching=True)
    assert s.events == []


def test_touching_the_board_ends_a_gesture_in_progress():
    s = Script().still(0.8, make_hand("fist"))
    assert len(s.named("pan", "start")) == 1
    s.still(0.1, make_hand("point"), touching=True)
    assert len(s.named("pan", "end")) == 1


def test_a_hand_that_leaves_the_view_ends_its_gesture():
    s = Script().still(0.8, pinch()).still(0.6)
    assert len(s.named("rotate", "end")) == 1


# Robustness: hand identity, dropouts, degenerate zoom -------------------------------


def test_swapped_order_of_two_same_label_hands_does_not_make_the_board_jump():
    def frame(p, swap):
        fist = make_hand("fist", at=(400, 400 + 60 * p))
        other = make_hand("open", at=(900, 450))
        return [other, fist] if swap else [fist, other]

    s = Script()
    frames = 30
    for i in range(frames):
        s.events += s.engine.update(frame(i / (frames - 1), swap=i % 2 == 1), s.t)
        s.t += 1 / FPS
    moves = s.named("pan", "move")
    assert moves and max(abs(e["dx"]) + abs(e["dy"]) for e in moves) < 15
    assert s.named("pan", "end") == []


def test_a_label_flip_for_a_few_frames_keeps_the_same_hand():
    s = Script().hold(0.6, lambda p: [make_hand("fist", at=(500, 400 + 30 * p), label="Left")])
    s.hold(0.1, lambda p: [make_hand("fist", at=(500, 430 + 5 * p), label="Right")])
    s.hold(0.3, lambda p: [make_hand("fist", at=(500, 435 + 15 * p), label="Left")])
    assert len(s.named("pan", "start")) == 1
    assert s.named("pan", "end") == []
    assert max(abs(e["dy"]) for e in s.named("pan", "move")) < 15


def test_a_pinch_interrupted_by_a_dropout_is_not_a_tap():
    s = Script()
    for _ in range(2):
        s.still(0.1, pinch()).still(0.15).still(0.05, open_hand())
    s.still(0.5, open_hand())
    assert s.gestures("double_tap") == []


def test_zoom_waits_until_the_two_pinches_are_apart_and_is_capped():
    s = Script().hold(0.4, lambda p: two_pinches(4))  # practically on top of each other
    assert s.named("zoom") == []
    assert s.named("rotate") == []
    s.hold(0.6, lambda p: two_pinches(200 + 300 * p))
    scales = [e["scale"] for e in s.named("zoom", "move")]
    assert scales and max(scales) <= 10.0


def test_positions_are_mapped_to_the_board():
    engine = GestureEngine(to_board=lambda pts: pts * 2.0)
    s = Script(engine).still(0.8, pinch(at=(500, 500)))
    start = s.named("rotate", "start")[0]
    point = make_hand("pinch", at=(500, 500)).landmarks[[4, 8]].mean(axis=0) * 2
    assert (start["x"], start["y"]) == (round(point[0], 1), round(point[1], 1))
