import base64

import numpy as np
import pytest

from hackcc_cv.content import (
    ContentError,
    find_writing,
    median_image,
    png_data_url,
    read_region,
)
from tests.synthetic import (
    BOARD_SIZE,
    WRITING,
    camera_view,
    render_writing_board,
    true_camera_to_board,
)

WHOLE_BOARD = (0.0, 0.0, float(BOARD_SIZE[0]), float(BOARD_SIZE[1]))


def true_ink_box(area, pad=12):
    """The real extent of the drawn ink inside a WRITING area, measured from the board image."""
    board = render_writing_board()
    x, y, w, h = area
    patch = board[y - pad : y + h + pad, x - pad : x + w + pad] < 128
    ys, xs = np.nonzero(patch)
    return (x - pad + xs.min(), y - pad + ys.min(), xs.max() - xs.min() + 1, ys.max() - ys.min() + 1)


def overlaps(a, b, slack=6):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (
        abs(ax - bx) <= slack and abs(ay - by) <= slack
        and abs(ax + aw - bx - bw) <= slack and abs(ay + ah - by - bh) <= slack
    )


@pytest.fixture(scope="module")
def frame():
    return camera_view(render_writing_board())


def test_the_rectified_crop_is_the_board_seen_straight_on(frame):
    crop, scale = read_region(frame, true_camera_to_board(), WHOLE_BOARD)
    assert crop.ndim == 2
    assert crop.shape[1] == round(BOARD_SIZE[0] * scale)
    board = render_writing_board()
    small = board[:: max(1, round(1 / scale)), :: max(1, round(1 / scale))]
    assert abs(float(crop.mean()) - float(board.mean())) < 6
    assert small.size > 0


def test_each_piece_of_writing_is_found_where_it_is_on_the_board(frame):
    crop, scale = read_region(frame, true_camera_to_board(), WHOLE_BOARD)
    regions = find_writing(crop, scale, WHOLE_BOARD)
    assert len(regions) == 3
    for area in WRITING.values():
        expected = true_ink_box(area)
        assert any(overlaps(found, expected) for found in regions), (expected, regions)


def test_reading_part_of_the_board_only_finds_writing_there(frame):
    left_half = (0.0, 0.0, 700.0, float(BOARD_SIZE[1]))
    crop, scale = read_region(frame, true_camera_to_board(), left_half)
    regions = find_writing(crop, scale, left_half)
    assert len(regions) == 2  # the two equations, not the sketch on the right
    assert all(x + w <= 700 + 2 for x, _, w, _ in regions)


def test_a_dim_camera_image_still_finds_the_writing():
    frame = camera_view(render_writing_board(), brightness=0.55)
    crop, scale = read_region(frame, true_camera_to_board(), WHOLE_BOARD)
    assert len(find_writing(crop, scale, WHOLE_BOARD)) == 3


def test_a_blank_board_has_no_writing():
    blank = camera_view(np.full((BOARD_SIZE[1], BOARD_SIZE[0]), 245, np.uint8))
    crop, scale = read_region(blank, true_camera_to_board(), WHOLE_BOARD)
    assert find_writing(crop, scale, WHOLE_BOARD) == []


def test_specks_of_noise_are_not_writing():
    board = np.full((BOARD_SIZE[1], BOARD_SIZE[0]), 245, np.uint8)
    rng = np.random.default_rng(4)
    for x, y in rng.integers((20, 20), (1200, 760), size=(40, 2)):
        board[y : y + 2, x : x + 2] = 40
    crop, scale = read_region(camera_view(board), true_camera_to_board(), WHOLE_BOARD)
    assert find_writing(crop, scale, WHOLE_BOARD) == []


def test_a_slightly_off_calibration_does_not_turn_the_frame_edge_into_writing(frame):
    shifted = np.array([[1, 0, 4], [0, 1, 4], [0, 0, 1]], dtype=np.float64) @ true_camera_to_board()
    crop, scale = read_region(frame, shifted, WHOLE_BOARD)
    assert len(find_writing(crop, scale, WHOLE_BOARD)) == 3


def test_uneven_light_across_the_board_still_finds_only_the_writing():
    board = render_writing_board().astype(np.float64)
    shading = np.linspace(1.0, 0.65, board.shape[1])[None, :]  # darker towards the right
    frame = camera_view((board * shading).astype(np.uint8))
    crop, scale = read_region(frame, true_camera_to_board(), WHOLE_BOARD)
    assert len(find_writing(crop, scale, WHOLE_BOARD)) == 3


def test_the_crop_is_never_larger_than_what_the_camera_sees(frame):
    _, scale = read_region(frame, true_camera_to_board(), WHOLE_BOARD)
    assert scale <= 1.0


def test_median_ignores_frames_of_a_different_size():
    a = np.full((20, 20, 3), 200, np.uint8)
    b = np.full((10, 10, 3), 0, np.uint8)
    assert median_image([a, b, a]).shape == (20, 20, 3)


def test_a_region_outside_the_board_is_refused(frame):
    with pytest.raises(ContentError):
        read_region(frame, true_camera_to_board(), (2000.0, 0.0, 100.0, 100.0))


def test_median_of_frames_removes_a_one_frame_flicker():
    still = np.full((20, 20, 3), 200, np.uint8)
    flicker = still.copy()
    flicker[5:10, 5:10] = 0
    result = median_image([still, flicker, still])
    assert np.array_equal(result, still)


def test_png_data_url_is_a_png_and_is_shrunk_if_huge():
    url = png_data_url(np.full((3000, 4000), 255, np.uint8), max_side=1600)
    assert url.startswith("data:image/png;base64,")
    data = base64.b64decode(url.split(",", 1)[1])
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width = int.from_bytes(data[16:20], "big")
    assert width == 1600
