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


# -- physical writing on the board (Phase 4) ------------------------------------------

# Where the "marker writing" is on the board, as (x, y, w, h) in board CSS px.
WRITING = {
    "equation_1": (150, 140, 420, 70),
    "equation_2": (150, 330, 520, 70),
    "sketch": (860, 420, 220, 200),
}


def render_writing_board() -> np.ndarray:
    """A white board with two handwritten-looking lines and a sketched box."""
    w, h = BOARD_SIZE
    board = np.full((h, w), 245, np.uint8)
    for name in ("equation_1", "equation_2"):
        x, y, bw, bh = WRITING[name]
        # Letters as separate thick strokes with gaps, like handwriting.
        for i, cx in enumerate(range(x, x + bw, 52)):
            top = y + (i % 2) * 8
            cv2.line(board, (cx, top), (min(cx + 34, x + bw), y + bh - (i % 3) * 6), 30, 7)
            cv2.line(board, (cx, y + bh // 2), (min(cx + 30, x + bw), y + bh // 2), 30, 6)
    x, y, bw, bh = WRITING["sketch"]
    cv2.rectangle(board, (x + 4, y + 4), (x + bw - 4, y + bh - 4), 40, 8)
    return board


def camera_view(board: np.ndarray, *, brightness: float = 1.0) -> np.ndarray:
    """The board image as the oblique camera sees it (BGR)."""
    w, h = CAMERA_SIZE
    view = cv2.warpPerspective(board, board_to_camera(), (w, h), borderValue=70)
    view = np.clip(view.astype(np.float64) * brightness, 0, 255).astype(np.uint8)
    return cv2.cvtColor(view, cv2.COLOR_GRAY2BGR)


def true_camera_to_board() -> np.ndarray:
    """The exact camera px -> board CSS px mapping for the synthetic scene."""
    css_from_centre = np.array([[1, 0, 0.5], [0, 1, 0.5], [0, 0, 1]], dtype=np.float64)
    return css_from_centre @ np.linalg.inv(board_to_camera())


# -- printed (static) markers around the board, seen directly by the camera (Phase 5) --

STATIC_SPOTS = {40: (30, 25), 41: (1180, 25), 42: (30, 625), 43: (1180, 625)}  # top-left, camera px
STATIC_SIZE = 70


def add_static_markers(frame: np.ndarray, dx: int = 0, dy: int = 0) -> np.ndarray:
    """A copy of a camera frame with the printed markers stuck around the board (shifted by dx, dy)."""
    out = frame.copy()
    for marker_id, (x, y) in STATIC_SPOTS.items():
        tile = np.full((STATIC_SIZE + 20, STATIC_SIZE + 20), 255, np.uint8)  # white paper margin
        tile[10:-10, 10:-10] = marker_image(marker_id, STATIC_SIZE)
        x0, y0 = x + dx - 10, y + dy - 10
        out[y0 : y0 + tile.shape[0], x0 : x0 + tile.shape[1]] = cv2.cvtColor(tile, cv2.COLOR_GRAY2BGR)
    return out
