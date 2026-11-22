"""Mapping camera pixels to board pixels (and back) with a homography.

A homography is a 3x3 matrix that maps points on one plane (the board, as the
camera sees it) to another (the board page in the browser). It also undoes the
camera's oblique angle and the projector's keystone, as long as the board is flat.

Corner order everywhere: top-left, top-right, bottom-right, bottom-left
(clockwise on screen, where y points down).
"""

from __future__ import annotations

from collections.abc import Sequence

import cv2
import numpy as np

Point = tuple[float, float]
Points = Sequence[Sequence[float]] | np.ndarray

EDGE_MARGIN_PX = 2.0  # how far outside the camera image a click may land (rounding)
MIN_AREA_FRACTION = 0.01  # the board must cover at least 1% of the camera image
MIN_DETERMINANT = 1e-12


class HomographyError(ValueError):
    """The points can't give a usable mapping. The message says what to fix."""


def _as_points(points: Points, name: str) -> np.ndarray:
    try:
        array = np.asarray(points, dtype=np.float64)
    except (TypeError, ValueError) as error:
        raise HomographyError(f"Every {name} point must be a number pair.") from error
    if array.size == 0:
        return np.zeros((0, 2))
    if array.ndim != 2 or array.shape[1] != 2:
        raise HomographyError(f"Every {name} point must be a number pair.")
    if not np.all(np.isfinite(array)):
        raise HomographyError(f"Every {name} point must be a number.")
    return array


def _cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    return float((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))


def _segments_cross(p1: np.ndarray, p2: np.ndarray, q1: np.ndarray, q2: np.ndarray) -> bool:
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    return d1 * d2 < 0 and d3 * d4 < 0


def _signed_area(quad: np.ndarray) -> float:
    x, y = quad[:, 0], quad[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def validate_quad(points: Points, camera_size: tuple[int, int]) -> None:
    """Check four clicked corners. Raises HomographyError explaining what is wrong."""
    try:
        quad = _as_points(points, "corner")
    except HomographyError:
        raise HomographyError("Every corner must be a number pair.") from None
    if quad.shape != (4, 2):
        raise HomographyError(f"Click exactly 4 points (got {len(quad)}).")

    width, height = camera_size
    for number, (x, y) in enumerate(quad, start=1):
        inside_x = -EDGE_MARGIN_PX <= x <= width + EDGE_MARGIN_PX
        inside_y = -EDGE_MARGIN_PX <= y <= height + EDGE_MARGIN_PX
        if not (inside_x and inside_y):
            raise HomographyError(f"Point {number} is not inside the camera image.")

    wrong_order = (
        "Click the targets in order 1, 2, 3, 4: "
        "top-left, top-right, bottom-right, bottom-left."
    )
    if _segments_cross(quad[0], quad[1], quad[2], quad[3]) or _segments_cross(
        quad[1], quad[2], quad[3], quad[0]
    ):
        raise HomographyError(wrong_order)
    area = _signed_area(quad)
    if area <= 0:
        raise HomographyError(wrong_order)
    if area < MIN_AREA_FRACTION * width * height:
        raise HomographyError(
            "The board looks too small in the camera. Move the camera closer or click the targets."
        )
    turns = [_cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]) for i in range(4)]
    if min(turns) <= 0:
        raise HomographyError(
            "The 4 points don't form a proper four-sided shape. Click the targets at the corners."
        )


def _normalised(matrix: np.ndarray) -> np.ndarray:
    if not np.all(np.isfinite(matrix)) or abs(np.linalg.det(matrix)) < MIN_DETERMINANT:
        raise HomographyError("These points don't give a usable mapping.")
    if abs(matrix[2, 2]) > MIN_DETERMINANT:
        matrix = matrix / matrix[2, 2]
    return matrix


def homography_with_inliers(
    source: Points, target: Points, ransac_px: float = 3.0
) -> tuple[np.ndarray, np.ndarray]:
    """The 3x3 matrix mapping `source` onto `target`, and which pairs it agrees with.

    Exactly 4 pairs give an exact fit (all inliers); more pairs (ArUco corners) use
    RANSAC, so pairs further than `ransac_px` (target units) from the fit are ignored.
    """
    src, dst = _as_points(source, "source"), _as_points(target, "target")
    if len(src) != len(dst) or len(src) < 4:
        raise HomographyError("Need at least 4 matching point pairs.")
    if len(src) == 4:
        matrix = cv2.getPerspectiveTransform(src.astype(np.float32), dst.astype(np.float32))
        inliers = np.ones(4, dtype=bool)
    else:
        matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, ransac_px)
        if matrix is None or mask is None:
            raise HomographyError("These points don't give a usable mapping.")
        inliers = mask.ravel().astype(bool)
    return _normalised(np.asarray(matrix, dtype=np.float64)), inliers


def homography_from_points(source: Points, target: Points, ransac_px: float = 3.0) -> np.ndarray:
    """The 3x3 matrix mapping `source` points onto `target` points."""
    return homography_with_inliers(source, target, ransac_px)[0]


def invert(matrix: np.ndarray) -> np.ndarray:
    """The mapping the other way (board to camera)."""
    try:
        return _normalised(np.linalg.inv(matrix))
    except np.linalg.LinAlgError as error:
        raise HomographyError("This mapping can't be reversed.") from error


def map_points(matrix: np.ndarray, points: Points) -> np.ndarray:
    """Map an (N, 2) list of points. Points that go to infinity come back as NaN."""
    array = _as_points(points, "")
    if len(array) == 0:
        return np.zeros((0, 2))
    homogeneous = np.hstack([array, np.ones((len(array), 1))]) @ np.asarray(matrix).T
    w = homogeneous[:, 2:3]
    with np.errstate(divide="ignore", invalid="ignore"):
        mapped = homogeneous[:, :2] / w
    mapped[np.abs(w[:, 0]) < MIN_DETERMINANT] = np.nan
    return mapped


def map_point(matrix: np.ndarray, x: float, y: float) -> Point:
    mapped = map_points(matrix, [(x, y)])[0]
    return float(mapped[0]), float(mapped[1])


def reprojection_error(matrix: np.ndarray, source: Points, target: Points) -> float:
    """Average distance, in target pixels, between mapped source points and targets."""
    mapped = map_points(matrix, source)
    return float(np.mean(np.linalg.norm(mapped - _as_points(target, "target"), axis=1)))
