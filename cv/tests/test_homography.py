import numpy as np
import pytest

from hackcc_cv.homography import (
    HomographyError,
    homography_from_points,
    invert,
    map_point,
    map_points,
    reprojection_error,
    validate_quad,
)

CAMERA_SIZE = (1280, 720)
# A board as the camera sees it from the front-left: a skewed, shrunk quadrilateral.
CAMERA_QUAD = [(300.0, 120.0), (1100.0, 180.0), (1040.0, 640.0), (260.0, 600.0)]
BOARD_TARGETS = [(100.0, 80.0), (1600.0, 80.0), (1600.0, 980.0), (100.0, 980.0)]


def test_the_four_clicked_points_map_exactly_onto_the_targets():
    h = homography_from_points(CAMERA_QUAD, BOARD_TARGETS)
    mapped = map_points(h, CAMERA_QUAD)
    assert np.allclose(mapped, BOARD_TARGETS, atol=1e-6)
    assert reprojection_error(h, CAMERA_QUAD, BOARD_TARGETS) < 1e-6


def test_a_known_perspective_is_recovered_to_under_one_pixel_everywhere():
    truth = np.array([[1.3, 0.12, 40.0], [-0.08, 1.4, 25.0], [0.0002, 0.0001, 1.0]])
    camera_points = map_points(np.linalg.inv(truth), BOARD_TARGETS)
    h = homography_from_points(camera_points, BOARD_TARGETS)

    rng = np.random.default_rng(7)
    board_samples = rng.uniform((0, 0), (1700, 1060), size=(200, 2))
    camera_samples = map_points(np.linalg.inv(truth), board_samples)
    error = np.linalg.norm(map_points(h, camera_samples) - board_samples, axis=1)
    assert error.max() < 1.0


def test_inverse_maps_board_points_back_to_the_camera():
    h = homography_from_points(CAMERA_QUAD, BOARD_TARGETS)
    back = map_points(invert(h), BOARD_TARGETS)
    assert np.allclose(back, CAMERA_QUAD, atol=1e-6)


def test_map_point_returns_plain_floats():
    h = homography_from_points(CAMERA_QUAD, BOARD_TARGETS)
    x, y = map_point(h, *CAMERA_QUAD[0])
    assert isinstance(x, float) and isinstance(y, float)
    assert (x, y) == pytest.approx(BOARD_TARGETS[0], abs=1e-6)


def test_map_points_accepts_an_empty_list():
    h = np.eye(3)
    assert map_points(h, []).shape == (0, 2)


def test_valid_quad_passes():
    validate_quad(CAMERA_QUAD, CAMERA_SIZE)  # no error


@pytest.mark.parametrize(
    ("points", "message"),
    [
        (CAMERA_QUAD[:3], "4 points"),
        ([(300, 120), (1100, 180), (float("nan"), 640), (260, 600)], "number"),
        ([(300, 120), (1100, 180), (1040, 640), (-90, 600)], "inside the camera"),
        (list(reversed(CAMERA_QUAD)), "order"),
        ([(300, 120), (1040, 640), (1100, 180), (260, 600)], "order"),  # bow-tie
        ([(600, 300), (620, 300), (620, 312), (600, 312)], "too small"),
        ([(100, 100), (600, 100), (1100, 100), (600, 101)], "too small"),
        ([(300, 120), (1100, 180), (700, 170), (260, 600)], "corners"),  # not convex
    ],
)
def test_bad_quads_are_rejected_with_a_reason(points, message):
    with pytest.raises(HomographyError, match=message):
        validate_quad(points, CAMERA_SIZE)


def test_homography_from_points_checks_its_input():
    with pytest.raises(HomographyError):
        homography_from_points(CAMERA_QUAD, BOARD_TARGETS[:3])
