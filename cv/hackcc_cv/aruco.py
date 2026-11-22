"""Finding the projected ArUco grid in camera images and turning it into a calibration."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .homography import HomographyError, homography_with_inliers, map_points
from .markers import PatternMarker, dictionary

MIN_MARKERS = 4  # 16 corners; fewer can't be trusted
MAX_ERROR_PX = 3.0  # average corner error on the board, in board px
MIN_SPREAD = 0.6  # found markers must span this share of the grid, across and down
MIN_FRAME_SHARE = 0.5  # a marker must be seen in at least half the frames
RANSAC_PX = 4.0  # corners further than this (board px) from the fit are ignored
MIN_INLIER_SHARE = 0.75  # most found corners must agree with the fit


class AutoCalibrationError(ValueError):
    """The pattern could not be used. The message says what to fix."""


@dataclass(frozen=True)
class Solution:
    matrix: np.ndarray  # camera px -> board px
    markers_found: int
    points: int
    error_px: float  # average over all found corners, in board px
    max_error_px: float


def make_detector() -> cv2.aruco.ArucoDetector:
    parameters = cv2.aruco.DetectorParameters()
    # Sub-pixel corners: the calibration is only as good as these points.
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    # Printed markers around the board often sit near the edge of the camera's view; with
    # OpenCV's default they are dropped there (tested: 1 of 4 found after a 12 px shift).
    # RANSAC and the per-marker median already guard against an off corner at the edge.
    parameters.minDistanceToBorder = 0
    return cv2.aruco.ArucoDetector(dictionary(), parameters)


def detect_markers(image: np.ndarray, detector: cv2.aruco.ArucoDetector) -> dict[int, np.ndarray]:
    """Marker id -> its 4 corners in camera px. Ids seen twice are dropped (ambiguous)."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    corners, ids, _ = detector.detectMarkers(gray)
    if ids is None:
        return {}
    found: dict[int, np.ndarray] = {}
    duplicates: set[int] = set()
    for raw_id, quad in zip(ids.flatten().tolist(), corners):
        marker_id = int(raw_id)
        if marker_id in found:
            duplicates.add(marker_id)
        found[marker_id] = quad.reshape(4, 2).astype(np.float64)
    for marker_id in duplicates:
        del found[marker_id]
    return found


def median_corners(frames: list[dict[int, np.ndarray]]) -> dict[int, np.ndarray]:
    """Per marker, the median of each corner over the frames that saw it.

    A median ignores a few noisy frames. Markers seen in too few frames are dropped.
    """
    if not frames:
        return {}
    needed = max(1, int(np.ceil(MIN_FRAME_SHARE * len(frames))))
    result = {}
    for marker_id in {i for frame in frames for i in frame}:
        seen = [frame[marker_id] for frame in frames if marker_id in frame]
        if len(seen) >= needed:
            result[marker_id] = np.median(np.stack(seen), axis=0)
    return result


def _spread(found: list[PatternMarker], layout: list[PatternMarker]) -> float:
    """How much of the grid the found markers cover, across and down (the smaller share)."""

    def span(markers: list[PatternMarker], axis: int) -> float:
        centres = [(m.x if axis == 0 else m.y) + m.size / 2 for m in markers]
        return max(centres) - min(centres)

    full_x, full_y = span(layout, 0), span(layout, 1)
    share_x = span(found, 0) / full_x if full_x else 1.0
    share_y = span(found, 1) / full_y if full_y else 1.0
    return min(share_x, share_y)


def solve(corners: dict[int, np.ndarray], layout: list[PatternMarker]) -> Solution:
    """Camera-to-board mapping from the found markers. Raises AutoCalibrationError."""
    by_id = {m.id: m for m in layout}
    found = [by_id[i] for i in sorted(corners) if i in by_id]
    total = len(layout)
    if len(found) < MIN_MARKERS:
        raise AutoCalibrationError(
            f"Found {len(found)} of {total} markers; need at least {MIN_MARKERS}. "
            "Check that the camera sees the whole board and the room is not too bright."
        )
    if _spread(found, layout) < MIN_SPREAD:
        raise AutoCalibrationError(
            f"Found {len(found)} of {total} markers, but they are not spread across the board. "
            "Make sure nothing covers part of the board."
        )

    camera = np.concatenate([corners[m.id] for m in found])
    board = np.array([point for m in found for point in m.corners()], dtype=np.float64)
    try:
        matrix, inliers = homography_with_inliers(camera, board, ransac_px=RANSAC_PX)
    except HomographyError as error:
        raise AutoCalibrationError(f"The markers did not give a usable mapping: {error}") from error
    if inliers.sum() < MIN_INLIER_SHARE * len(board):
        raise AutoCalibrationError(
            f"Only {int(inliers.sum())} of {len(board)} marker corners agree with each other. "
            "Keep the camera still and make sure the board is flat."
        )
    # Judge the fit on the corners it kept; the ones RANSAC threw out are misreads.
    camera, board = camera[inliers], board[inliers]
    errors: np.ndarray = np.asarray(np.linalg.norm(map_points(matrix, camera) - board, axis=1))
    if not np.all(np.isfinite(errors)) or float(np.mean(errors)) > MAX_ERROR_PX:
        raise AutoCalibrationError(
            f"The calibration is not accurate enough (average error {float(np.nanmean(errors)):.1f} px). "
            "Keep the camera still and try again."
        )
    return Solution(
        matrix=matrix,
        markers_found=len(found),
        points=len(board),
        error_px=float(np.mean(errors)),
        max_error_px=float(np.max(errors)),
    )
