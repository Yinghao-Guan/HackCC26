"""The ArUco markers the board page shows for automatic calibration.

The board page draws a 4 x 3 grid of markers at positions we choose, in board
pixels. Finding them in the camera image gives 48 matching corner pairs.

Marker ids: 0-11 for the projected grid, 40-47 kept for printed markers stuck
around the board (drift detection, a later phase). DICT_4X4_50 is the smallest
dictionary that fits, which makes misreads least likely.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import cv2
import numpy as np

from .events import Display

DICTIONARY_ID = cv2.aruco.DICT_4X4_50
GRID_COLUMNS = 4
GRID_ROWS = 3
GRID_IDS = tuple(range(GRID_COLUMNS * GRID_ROWS))
STATIC_MARKER_IDS = tuple(range(40, 48))

EDGE_MARGIN = 0.04  # keep markers this fraction of the board away from its edges
FILL = 0.62  # a marker takes this share of its grid cell; the rest is white space
PNG_MODULES = 6  # 4 x 4 bits plus a one-bit black border on each side
PNG_PIXELS_PER_MODULE = 20


@dataclass(frozen=True)
class PatternMarker:
    """One marker as drawn on the board page: top-left corner and side, in board px."""

    id: int
    x: float
    y: float
    size: float

    def corners(self) -> list[tuple[float, float]]:
        """Top-left, top-right, bottom-right, bottom-left: OpenCV's corner order."""
        right, bottom = self.x + self.size, self.y + self.size
        return [(self.x, self.y), (right, self.y), (right, bottom), (self.x, bottom)]


def grid_layout(
    display: Display, columns: int = GRID_COLUMNS, rows: int = GRID_ROWS
) -> list[PatternMarker]:
    """Markers spread evenly over the board, as large as fits, ids row by row."""
    left = display.width * EDGE_MARGIN
    top = display.height * EDGE_MARGIN
    cell_w = (display.width - 2 * left) / columns
    cell_h = (display.height - 2 * top) / rows
    size = FILL * min(cell_w, cell_h)
    layout = []
    for row in range(rows):
        for column in range(columns):
            centre_x = left + (column + 0.5) * cell_w
            centre_y = top + (row + 0.5) * cell_h
            layout.append(
                PatternMarker(
                    id=row * columns + column,
                    x=round(centre_x - size / 2, 2),
                    y=round(centre_y - size / 2, 2),
                    size=round(size, 2),
                )
            )
    return layout


@lru_cache(maxsize=1)
def dictionary() -> cv2.aruco.Dictionary:
    return cv2.aruco.getPredefinedDictionary(DICTIONARY_ID)


def marker_image(marker_id: int, pixels: int) -> np.ndarray:
    """A black-and-white marker image (grayscale) of the given side length."""
    return cv2.aruco.generateImageMarker(dictionary(), marker_id, pixels, borderBits=1)


@lru_cache(maxsize=64)
def marker_png_data_url(marker_id: int) -> str:
    """A small PNG the browser scales up with crisp pixels (image-rendering: pixelated)."""
    image = marker_image(marker_id, PNG_MODULES * PNG_PIXELS_PER_MODULE)
    ok, buffer = cv2.imencode(".png", image)
    if not ok:
        raise ValueError(f"Could not encode marker {marker_id} as PNG.")
    return "data:image/png;base64," + base64.b64encode(buffer.tobytes()).decode("ascii")


def pattern_event(layout: list[PatternMarker], run: int | None = None) -> dict[str, Any]:
    """Tell board pages to show these markers on a white page. An empty list hides them.

    `run` numbers each showing; the board page echoes it in its "shown" reply, so a late
    reply from an earlier attempt can't be mistaken for this one.
    """
    event: dict[str, Any] = {} if run is None else {"run": run}
    return event | {
        "type": "calibration_pattern",
        "markers": [
            {"id": m.id, "x": m.x, "y": m.y, "size": m.size, "png": marker_png_data_url(m.id)}
            for m in layout
        ],
    }
