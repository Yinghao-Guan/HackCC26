import numpy as np
import pytest

from hackcc_cv.aruco import (
    AutoCalibrationError,
    detect_markers,
    make_detector,
    median_corners,
    solve,
)
from hackcc_cv.events import Display
from hackcc_cv.homography import map_points
from tests.synthetic import BOARD_SIZE, camera_frame, css_to_camera

LAYOUT_DISPLAY = Display(*BOARD_SIZE, 1)


@pytest.fixture(scope="module")
def layout():
    from hackcc_cv.markers import grid_layout

    return grid_layout(LAYOUT_DISPLAY)


def board_error(matrix, samples=300):
    """Largest distance (board px) between the solved and the true mapping, over the board."""
    rng = np.random.default_rng(3)
    board = rng.uniform((0, 0), BOARD_SIZE, size=(samples, 2))
    camera = css_to_camera(board)
    return float(np.linalg.norm(map_points(matrix, camera) - board, axis=1).max())


def test_all_twelve_markers_are_found_with_accurate_corners(layout):
    found = detect_markers(camera_frame(layout), make_detector())
    assert sorted(found) == list(range(12))
    truth = css_to_camera(layout[5].corners())
    assert np.abs(found[5] - truth).max() < 1.0


def test_solve_recovers_the_true_mapping_to_under_a_pixel(layout):
    found = detect_markers(camera_frame(layout), make_detector())
    solution = solve(found, layout)
    assert solution.markers_found == 12
    assert solution.points == 48
    assert solution.error_px < 1.0
    assert board_error(solution.matrix) < 1.0


def test_blur_and_noise_still_calibrate(layout):
    detector = make_detector()
    frames = [camera_frame(layout, blur=3, noise=6.0, seed=s) for s in range(5)]
    solution = solve(median_corners([detect_markers(f, detector) for f in frames]), layout)
    assert board_error(solution.matrix) < 2.0


def test_hidden_markers_are_fine_while_enough_spread_out_ones_remain(layout):
    hidden = {1, 2, 5, 6}  # e.g. a hand or a sheet of paper over the middle
    found = detect_markers(camera_frame(layout, hide=hidden), make_detector())
    assert not hidden & set(found)
    assert board_error(solve(found, layout).matrix) < 1.0


def test_one_misread_marker_is_ignored_by_ransac_and_not_counted_in_the_error(layout):
    found = detect_markers(camera_frame(layout), make_detector())
    found[6] = found[6] + 30.0  # one marker read 30 px off
    solution = solve(found, layout)
    assert solution.points == 44  # its 4 corners were thrown out
    assert solution.error_px < 1.0
    assert board_error(solution.matrix) < 1.0


def test_too_few_markers_is_an_error_that_says_how_many(layout):
    found = detect_markers(camera_frame(layout, hide=set(range(2, 12))), make_detector())
    with pytest.raises(AutoCalibrationError, match="2 of 12"):
        solve(found, layout)


def test_markers_bunched_in_one_corner_are_rejected(layout):
    only_left = {m.id for m in layout} - {0, 4, 8, 1, 5}
    found = detect_markers(camera_frame(layout, hide=only_left), make_detector())
    with pytest.raises(AutoCalibrationError, match="spread"):
        solve(found, layout)


def test_a_blank_view_finds_nothing(layout):
    blank = np.full((720, 1280, 3), 128, np.uint8)
    assert detect_markers(blank, make_detector()) == {}
    with pytest.raises(AutoCalibrationError, match="0 of 12"):
        solve({}, layout)


def test_median_ignores_one_bad_frame_and_rare_markers():
    good = np.array([[10, 10], [20, 10], [20, 20], [10, 20]], np.float64)
    frames = [{0: good}, {0: good + 0.2}, {0: good + 50, 9: good}, {0: good - 0.2}]
    result = median_corners(frames)
    assert np.abs(result[0] - good).max() < 0.3
    assert 9 not in result  # seen in only 1 of 4 frames


def test_median_of_no_frames_is_empty():
    assert median_corners([]) == {}
