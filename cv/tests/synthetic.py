"""Fake camera images of a board showing the ArUco grid, with a known perspective."""

from __future__ import annotations

import cv2
import numpy as np

from hackcc_cv.markers import PatternMarker, marker_image

BOARD_SIZE = (1280, 800)  # board page, CSS px
CAMERA_SIZE = (1280, 720)
# Where the board's corners land in the camera image (front-left, oblique view).
BOARD_IN_CAMERA = np.float32([(260, 110), (1060, 150), (1020, 620), (230, 590)])


def board_to_camera() -> np.ndarray:
    w, h = BOARD_SIZE
    board_corners = np.float32([(0, 0), (w, 0), (w, h), (0, h)])
    return cv2.getPerspectiveTransform(board_corners, BOARD_IN_CAMERA).astype(np.float64)


def css_to_camera(points) -> np.ndarray:
    """Where board CSS points appear in the camera image.

    A CSS coordinate x is a pixel *edge*; OpenCV images use pixel *centres*, so the
    board image pixel-centre coordinate is x - 0.5.
    """
    from hackcc_cv.homography import map_points

    return map_points(board_to_camera(), np.asarray(points, dtype=np.float64) - 0.5)


def render_board(layout: list[PatternMarker], hide: set[int] | None = None) -> np.ndarray:
    """The board page as the projector shows it: white, with the markers drawn at their
    exact (sub-pixel) CSS positions."""
    w, h = BOARD_SIZE
    board = np.full((h, w), 255, np.uint8)
    source_px = 120
    for marker in layout:
        if hide and marker.id in hide:
            continue
        scale = marker.size / source_px
        # Source pixel edges [-0.5, 119.5] -> board centres [x - 0.5, x + size - 0.5].
        affine = np.float64([
            [scale, 0, 0.5 * scale + marker.x - 0.5],
            [0, scale, 0.5 * scale + marker.y - 0.5],
        ])
        drawn = cv2.warpAffine(
            marker_image(marker.id, source_px), affine, (w, h),
            flags=cv2.INTER_AREA, borderValue=255,
        )
        board = np.minimum(board, drawn)
    return board


def camera_frame(
    layout: list[PatternMarker],
    *,
    hide: set[int] | None = None,
    blur: int = 0,
    noise: float = 0.0,
    seed: int = 1,
) -> np.ndarray:
    """What the camera sees: the board warped into a grey room, as a BGR image."""
    w, h = CAMERA_SIZE
    view = cv2.warpPerspective(
        render_board(layout, hide), board_to_camera(), (w, h), borderValue=90
    )
    if blur:
        view = cv2.GaussianBlur(view, (blur, blur), 0)
    if noise:
        rng = np.random.default_rng(seed)
        view = np.clip(view + rng.normal(0, noise, view.shape), 0, 255).astype(np.uint8)
    return cv2.cvtColor(view, cv2.COLOR_GRAY2BGR)
