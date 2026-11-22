import numpy as np

from hackcc_cv.drift import (
    CONFIRM_CHECKS,
    SETTLE_CHECKS,
    DriftMonitor,
    StaticMarker,
    static_markers_in,
)

BASE = [
    StaticMarker(40, 60.0, 60.0, 70.0),
    StaticMarker(41, 1200.0, 60.0, 70.0),
    StaticMarker(42, 60.0, 650.0, 70.0),
    StaticMarker(43, 1200.0, 650.0, 70.0),
]


def shifted(markers, dx, dy, only=None):
    return [
        StaticMarker(m.id, m.x + dx, m.y + dy, m.size) if only is None or m.id in only else m
        for m in markers
    ]


def run(monitor, frames):
    return [monitor.update(BASE, found) for found in frames]


def test_static_markers_are_picked_out_of_detections_by_id():
    square = np.array([[0, 0], [10, 0], [10, 10], [0, 10]], dtype=np.float64)
    found = {3: square, 40: square + 100, 47: square + 200, 48: square}
    markers = static_markers_in(found)
    assert [m.id for m in markers] == [40, 47]
    assert (markers[0].x, markers[0].y, markers[0].size) == (105.0, 105.0, 10.0)


def test_printed_markers_near_the_edge_of_the_view_are_still_found():
    from hackcc_cv.aruco import detect_markers, make_detector
    from tests.test_server_drift import scene

    for shift in [(0, 0), (12, 0), (0, 7), (12, 7), (-12, -7)]:
        found = static_markers_in(detect_markers(scene(*shift), make_detector()))
        assert [m.id for m in found] == [40, 41, 42, 43], shift


def test_markers_where_they_were_are_steady():
    verdicts = run(DriftMonitor(), [BASE] * 5)
    assert {v.status for v in verdicts} == {"steady"}
    assert verdicts[-1].shift_px == 0.0
    assert verdicts[-1].seen == 4


def test_tiny_jitter_is_still_steady():
    assert run(DriftMonitor(), [shifted(BASE, 1.5, -1.0)] * 5)[-1].status == "steady"


def test_a_move_is_confirmed_then_waits_for_the_camera_to_settle_then_asks_to_recalibrate():
    moved = shifted(BASE, 15, 8)
    verdicts = run(DriftMonitor(), [moved] * (CONFIRM_CHECKS + SETTLE_CHECKS + 1))
    statuses = [v.status for v in verdicts]
    assert statuses[: CONFIRM_CHECKS - 1] == ["checking"] * (CONFIRM_CHECKS - 1)
    assert "moved" in statuses
    assert statuses[-1] == "recalibrate"
    assert verdicts[-1].shift_px > 10


def test_a_camera_still_moving_does_not_recalibrate_yet():
    frames = [shifted(BASE, 10 + 6 * i, 5) for i in range(CONFIRM_CHECKS + SETTLE_CHECKS + 3)]
    assert "recalibrate" not in [v.status for v in run(DriftMonitor(), frames)]


def test_one_marker_misread_or_covered_by_a_hand_is_not_a_move():
    one_off = shifted(BASE, 40, 40, only={41})
    verdicts = run(DriftMonitor(), [one_off] * (CONFIRM_CHECKS + SETTLE_CHECKS + 2))
    assert {v.status for v in verdicts} == {"steady"}


def test_a_brief_bump_that_goes_back_is_not_a_move():
    frames = [shifted(BASE, 15, 0)] * (CONFIRM_CHECKS - 1) + [BASE] * 5
    assert "recalibrate" not in [v.status for v in run(DriftMonitor(), frames)]
    assert run(DriftMonitor(), frames)[-1].status == "steady"


def test_with_only_two_markers_one_wobbly_marker_is_not_a_move():
    two = BASE[:2]
    wobbly = [StaticMarker(40, 70.0, 68.0, 70.0), BASE[1]]  # 40 off by ~13 px, 41 steady
    monitor = DriftMonitor()
    verdicts = [monitor.update(two, wobbly) for _ in range(CONFIRM_CHECKS + SETTLE_CHECKS + 2)]
    assert {v.status for v in verdicts} == {"steady"}


def test_with_only_two_markers_both_moving_is_a_move():
    two = BASE[:2]
    monitor = DriftMonitor()
    verdicts = [monitor.update(two, shifted(two, 12, 7)) for _ in range(CONFIRM_CHECKS + 1)]
    assert verdicts[-1].status in ("moved", "recalibrate")


def test_too_few_markers_visible_is_unknown_not_moved():
    verdict = DriftMonitor().update(BASE, BASE[:1])
    assert verdict.status == "unknown"
    assert verdict.seen == 1


def test_without_a_baseline_monitoring_is_off():
    assert DriftMonitor().update([], BASE).status == "off"


def test_reset_starts_counting_again():
    monitor = DriftMonitor()
    run(monitor, [shifted(BASE, 15, 8)] * (CONFIRM_CHECKS + SETTLE_CHECKS + 1))
    monitor.reset()
    assert monitor.update(BASE, shifted(BASE, 15, 8)).status == "checking"
