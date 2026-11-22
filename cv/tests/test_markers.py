import base64

import cv2
import numpy as np

from hackcc_cv.events import Display
from hackcc_cv.markers import (
    GRID_IDS,
    STATIC_MARKER_IDS,
    grid_layout,
    marker_image,
    marker_png_data_url,
    pattern_event,
)


def test_grid_has_twelve_numbered_markers_inside_the_board():
    display = Display(1280, 800, 1)
    layout = grid_layout(display)
    assert [m.id for m in layout] == list(GRID_IDS)
    for m in layout:
        assert m.size > 50
        assert 0 < m.x and m.x + m.size < display.width
        assert 0 < m.y and m.y + m.size < display.height


def test_markers_do_not_overlap_and_leave_a_white_gap():
    layout = grid_layout(Display(1707, 1067, 1.5))
    for a in layout:
        for b in layout:
            if a.id < b.id:
                apart_x = a.x + a.size + 10 <= b.x or b.x + b.size + 10 <= a.x
                apart_y = a.y + a.size + 10 <= b.y or b.y + b.size + 10 <= a.y
                assert apart_x or apart_y


def test_marker_corners_are_clockwise_from_top_left():
    marker = grid_layout(Display(1280, 800, 1))[0]
    (tlx, tly), (trx, try_), (brx, bry), (blx, bly) = marker.corners()
    assert (tlx, tly) == (marker.x, marker.y)
    assert trx > tlx and try_ == tly
    assert brx == trx and bry > try_
    assert blx == tlx and bly == bry


def test_static_marker_ids_never_clash_with_the_grid():
    assert not set(GRID_IDS) & set(STATIC_MARKER_IDS)


def test_marker_image_is_detected_as_its_own_id():
    image = np.full((200, 200), 255, np.uint8)
    image[40:160, 40:160] = marker_image(7, 120)
    detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50))
    _, ids, _ = detector.detectMarkers(image)
    assert ids is not None and ids.flatten().tolist() == [7]


def test_marker_png_is_a_png_data_url():
    url = marker_png_data_url(3)
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1])[:8] == b"\x89PNG\r\n\x1a\n"


def test_pattern_event_lists_markers_and_an_empty_one_hides_them():
    layout = grid_layout(Display(1280, 800, 1))
    event = pattern_event(layout)
    assert event["type"] == "calibration_pattern"
    first = event["markers"][0]
    assert set(first) == {"id", "x", "y", "size", "png"}
    assert pattern_event([]) == {"type": "calibration_pattern", "markers": []}
