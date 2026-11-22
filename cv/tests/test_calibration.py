import json
import threading

import numpy as np
import pytest

from hackcc_cv.calibration import (
    Calibration,
    CalibrationError,
    CalibrationStore,
    load_calibration,
    manual_targets,
    save_calibration,
    stale_reason,
)
from hackcc_cv.events import Display

H = ((1.2, 0.1, 30.0), (-0.05, 1.3, 20.0), (0.0001, 0.0002, 1.0))


def make_calibration(**overrides):
    values = {
        "camera_to_board": H,
        "method": "manual",
        "camera_size": (1280, 720),
        "board_size": (1707.0, 1067.0),
        "reprojection_error_px": 0.0,
        "points": 4,
        "created_at": 1767000000.0,
    }
    values.update(overrides)
    return Calibration(**values)


def test_manual_targets_are_inside_the_board_in_clockwise_order():
    targets = manual_targets(Display(1000, 500, 1))
    xs = [x for x, _ in targets]
    ys = [y for _, y in targets]
    assert len(targets) == 4
    assert all(0 < x < 1000 for x in xs) and all(0 < y < 500 for y in ys)
    (tlx, tly), (trx, try_), (brx, bry), (blx, bly) = targets
    assert tlx < trx and tly == try_  # top edge, left to right
    assert brx == trx and bry > try_  # right edge, going down
    assert blx == tlx and bly == bry  # bottom edge


def test_calibration_round_trips_through_json():
    original = make_calibration()
    assert Calibration.from_json(original.to_json()) == original


def test_calibration_matrix_is_usable_with_numpy():
    matrix = make_calibration().matrix()
    assert matrix.shape == (3, 3)
    assert np.allclose(matrix[0], H[0])


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(camera_to_board=[[1, 0], [0, 1]]),
        lambda d: d.update(camera_to_board=[[1, 0, 0], [0, 1, 0], [0, 0, "x"]]),
        lambda d: d.update(camera_to_board=[[0, 0, 0], [0, 0, 0], [0, 0, 0]]),
        lambda d: d.update(method="guess"),
        lambda d: d.update(camera_size=[0, 720]),
        lambda d: d.pop("board_size"),
    ],
)
def test_corrupted_calibrations_are_rejected(mutate):
    data = json.loads(make_calibration().to_json())
    mutate(data)
    with pytest.raises(CalibrationError):
        Calibration.from_json(json.dumps(data))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(camera_size=[float("inf"), 720]),
        lambda d: d.update(board_size=[float("nan"), 500]),
        lambda d: d.update(created_at=float("inf")),
    ],
)
def test_infinite_or_nan_values_are_rejected(mutate):
    data = json.loads(make_calibration().to_json())
    mutate(data)
    with pytest.raises(CalibrationError):
        Calibration.from_json(json.dumps(data))


def test_two_saves_in_the_same_second_keep_both_history_copies(tmp_path):
    save_calibration(make_calibration(), tmp_path)
    save_calibration(make_calibration(method="aruco"), tmp_path)
    save_calibration(make_calibration(), tmp_path)
    assert len(list((tmp_path / "history").glob("*.json"))) == 3


def test_printed_marker_positions_are_saved_with_the_calibration(tmp_path):
    statics = ((40, 60.0, 60.0, 70.0), (41, 1200.0, 60.0, 70.0))
    calibration = make_calibration(static_markers=statics)
    save_calibration(calibration, tmp_path)
    loaded = load_calibration(tmp_path)
    assert loaded == calibration
    assert [m.id for m in loaded.static()] == [40, 41]


def test_older_calibration_files_without_printed_markers_still_load():
    data = json.loads(make_calibration().to_json())
    data.pop("static_markers", None)
    assert Calibration.from_json(json.dumps(data)).static_markers == ()


@pytest.mark.parametrize(
    "bad",
    [
        [[40, 1, 2]], [[40, "x", 2, 3]], [[7, 1, 2, 3]], [[40, float("nan"), 2, 3]], "nope",
        [[40, 10, 10, 0]],  # no size
        [[40, 10, 10, 30], [40, 20, 20, 30]],  # the same marker twice
        [[40, 5000, 10, 30]],  # outside the 1280 x 720 camera image
    ],
)
def test_bad_printed_marker_entries_are_rejected(bad):
    data = json.loads(make_calibration().to_json())
    data["static_markers"] = bad
    with pytest.raises(CalibrationError):
        Calibration.from_json(json.dumps(data))


def test_garbage_is_rejected():
    with pytest.raises(CalibrationError):
        Calibration.from_json("{not json")


def test_save_writes_the_latest_file_and_an_archive_copy(tmp_path):
    calibration = make_calibration()
    path = save_calibration(calibration, tmp_path)
    assert path == tmp_path / "calibration.json"
    assert load_calibration(tmp_path) == calibration
    archived = list((tmp_path / "history").glob("calibration-*.json"))
    assert len(archived) == 1
    assert not list(tmp_path.glob("*.tmp"))


def test_load_returns_none_when_there_is_no_calibration(tmp_path):
    assert load_calibration(tmp_path) is None


def test_load_raises_on_a_corrupted_file(tmp_path):
    (tmp_path / "calibration.json").write_text("{oops", encoding="utf-8")
    with pytest.raises(CalibrationError):
        load_calibration(tmp_path)


def test_a_matching_setup_is_not_stale():
    calibration = make_calibration()
    assert stale_reason(calibration, Display(1707, 1067, 1.5), (1280, 720)) is None


def test_a_resized_board_page_makes_the_calibration_stale():
    reason = stale_reason(make_calibration(), Display(1280, 720, 1), (1280, 720))
    assert reason is not None and "board" in reason


def test_a_different_camera_size_makes_the_calibration_stale():
    reason = stale_reason(make_calibration(), Display(1707, 1067, 1.5), (640, 480))
    assert reason is not None and "camera" in reason


def test_unknown_camera_size_is_not_treated_as_stale():
    assert stale_reason(make_calibration(), Display(1707, 1067, 1.5), None) is None


def test_store_holds_the_current_calibration_and_tells_listeners():
    seen = []
    store = CalibrationStore(on_change=seen.append)
    assert store.current() is None
    calibration = make_calibration()
    store.set(calibration)
    assert store.current() == calibration
    assert seen == [calibration]


def test_store_is_safe_to_read_from_other_threads():
    store = CalibrationStore()
    calibration = make_calibration()
    results = []
    writer = threading.Thread(target=store.set, args=(calibration,))
    writer.start()
    writer.join()
    reader = threading.Thread(target=lambda: results.append(store.current()))
    reader.start()
    reader.join()
    assert results == [calibration]
