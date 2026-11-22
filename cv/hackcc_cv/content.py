"""Reading physical writing on the board (docs/02-technical-design.md, section 6).

The board page shows plain white over the area to read, so the camera sees only what is
physically on the board. These helpers straighten that area out of the camera image with
the calibration, find where the writing is, and package the picture for the AI.

Board areas are (x, y, w, h) in board px (CSS px of the board page).
"""

from __future__ import annotations

import base64

import cv2
import numpy as np

from .homography import HomographyError, invert, map_points

Box = tuple[float, float, float, float]

MIN_SCALE, MAX_SCALE = 0.5, 1.0  # crop px per board px; never more than the camera resolves
EDGE_MARGIN_PX = 2.0
MERGE_GAP_BOARD_PX = 30.0  # strokes closer than this join into one region (a line of writing)
MIN_CONTRAST = 35  # ink must be this much darker than the board around it (0-255)
MIN_INK_BOARD_PX2 = 120.0  # smaller ink blobs are specks, not writing
MIN_SIDE_BOARD_PX = 10.0
MAX_PNG_SIDE = 1280
EDGE_BAND_BOARD_PX = 6.0  # ignore ink this close to the crop edge (calibration slack)
BACKGROUND_KERNEL_BOARD_PX = 50.0  # wider than any pen stroke: estimates the bare board


class ContentError(ValueError):
    """The area can't be read. The message says why."""


def median_image(frames: list[np.ndarray]) -> np.ndarray:
    """Per-pixel median of several frames: removes flicker and noise from any one frame."""
    if not frames:
        raise ContentError("The camera sent no images.")
    # If the camera changed resolution mid-capture, keep the frames that match the first.
    same = [f for f in frames if f.shape == frames[0].shape]
    return np.median(np.stack(same), axis=0).astype(np.uint8)


def read_region(image: np.ndarray, camera_to_board: np.ndarray, box: Box) -> tuple[np.ndarray, float]:
    """The board area `box`, straightened out of the camera image (grayscale), and its scale.

    The crop is `scale` px per board px, chosen near the camera's own resolution there.
    """
    x, y, w, h = (float(v) for v in box)
    if not all(np.isfinite([x, y, w, h])) or w <= 0 or h <= 0:
        raise ContentError("The area to read must have a positive width and height.")
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    try:
        board_to_camera = invert(np.asarray(camera_to_board, dtype=np.float64))
    except HomographyError as error:
        raise ContentError(f"The calibration can't be used: {error}") from error

    corners = np.array([(x, y), (x + w, y), (x + w, y + h), (x, y + h)])
    in_camera = map_points(board_to_camera, corners)
    height, width = gray.shape[:2]
    inside = (
        np.all(np.isfinite(in_camera))
        and np.all(in_camera[:, 0] >= -EDGE_MARGIN_PX) and np.all(in_camera[:, 0] <= width + EDGE_MARGIN_PX)
        and np.all(in_camera[:, 1] >= -EDGE_MARGIN_PX) and np.all(in_camera[:, 1] <= height + EDGE_MARGIN_PX)
    )
    if not inside:
        raise ContentError("Part of that area is outside what the camera sees.")

    edges_camera = np.linalg.norm(np.roll(in_camera, -1, axis=0) - in_camera, axis=1)
    edges_board = np.array([w, h, w, h])
    scale = float(np.clip(np.mean(edges_camera / edges_board), MIN_SCALE, MAX_SCALE))

    out_w, out_h = max(1, round(w * scale)), max(1, round(h * scale))
    # Output pixel centre (u, v) -> board CSS px -> camera px.
    out_to_board = np.array(
        [[1 / scale, 0, x + 0.5 / scale], [0, 1 / scale, y + 0.5 / scale], [0, 0, 1]], dtype=np.float64
    )
    crop = cv2.warpPerspective(
        gray, board_to_camera @ out_to_board, (out_w, out_h),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=255,
    )
    return crop, scale


def _odd(n: float) -> int:
    k = max(3, round(n))
    return k if k % 2 else k + 1


def find_writing(crop: np.ndarray, scale: float, box: Box) -> list[Box]:
    """Bounding boxes (board px) of each piece of writing in a straightened crop.

    Ink is what is clearly darker than the board around it; strokes close together are one
    region (a line of writing or a drawing); specks are ignored.
    """
    blur = cv2.GaussianBlur(crop, (5, 5), 0)
    local = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, _odd(40 * scale), 12
    )
    # The bare board around each point: closing removes dark strokes but keeps shading,
    # so ink is measured against its own surroundings, not one level for the whole board.
    background = cv2.morphologyEx(
        blur, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(BACKGROUND_KERNEL_BOARD_PX * scale),) * 2),
    )
    dark = ((background.astype(np.int16) - blur) > MIN_CONTRAST).astype(np.uint8) * 255
    ink = cv2.morphologyEx(cv2.bitwise_and(local, dark), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # A few px of calibration slack can pull the dark frame or unflashed content in at the
    # edges of the crop; that is never writing.
    band = max(2, round(EDGE_BAND_BOARD_PX * scale))
    ink[:band, :] = ink[-band:, :] = 0
    ink[:, :band] = ink[:, -band:] = 0

    gap = _odd(MERGE_GAP_BOARD_PX * scale)
    joined = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (gap, gap)))
    count, labels = cv2.connectedComponents(joined)

    bx, by = float(box[0]), float(box[1])
    min_ink = MIN_INK_BOARD_PX2 * scale * scale
    regions: list[Box] = []
    for label in range(1, count):
        points = cv2.findNonZero(cv2.bitwise_and(ink, ink, mask=(labels == label).astype(np.uint8)))
        if points is None or len(points) < min_ink:
            continue
        x, y, w, h = cv2.boundingRect(points)
        if w / scale < MIN_SIDE_BOARD_PX and h / scale < MIN_SIDE_BOARD_PX:
            continue
        regions.append((
            round(bx + x / scale, 1), round(by + y / scale, 1),
            round(w / scale, 1), round(h / scale, 1),
        ))
    return sorted(regions, key=lambda r: (r[1], r[0]))


def png_data_url(image: np.ndarray, max_side: int = MAX_PNG_SIDE) -> str:
    """The image as a PNG data URL, shrunk to at most `max_side` px on its long side."""
    height, width = image.shape[:2]
    if max(height, width) > max_side:
        factor = max_side / max(height, width)
        image = cv2.resize(
            image, (max(1, round(width * factor)), max(1, round(height * factor))),
            interpolation=cv2.INTER_AREA,
        )
    ok, buffer = cv2.imencode(".png", image)
    if not ok:
        raise ContentError("Could not encode the picture.")
    return "data:image/png;base64," + base64.b64encode(buffer.tobytes()).decode("ascii")
