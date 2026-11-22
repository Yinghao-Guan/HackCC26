import time

import numpy as np
import pytest

from hackcc_cv.camera import Camera, CameraError
from hackcc_cv.config import Config
from hackcc_cv.preview import annotate, encode_jpeg


class FakeCapture:
    """Stands in for cv2.VideoCapture: hands out numbered gray frames."""

    def __init__(self, index, backend, opened=True, fail_after=None):
        self.index = index
        self.backend = backend
        self.opened = opened
        self.fail_after = fail_after
        self.reads = 0
        self.props = {}
        self.released = False

    def isOpened(self):
        return self.opened

    def set(self, prop, value):
        self.props[prop] = value
        return True

    def get(self, prop):
        return self.props.get(prop, 0.0)

    def read(self):
        self.reads += 1
        time.sleep(0.002)
        if self.fail_after is not None and self.reads > self.fail_after:
            return False, None
        return True, np.full((48, 64, 3), self.reads % 255, np.uint8)

    def release(self):
        self.released = True


def wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def make_camera(**capture_kwargs):
    captures = []

    def factory(index, backend):
        capture = FakeCapture(index, backend, **capture_kwargs)
        captures.append(capture)
        return capture

    config = Config(warmup_seconds=0.0)
    return Camera(config, capture_factory=factory), captures


def test_camera_delivers_numbered_frames():
    camera, captures = make_camera()
    camera.start()
    try:
        assert wait_for(lambda: camera.latest() is not None and camera.latest().index >= 3)
        first = camera.latest()
        assert first.image.shape == (48, 64, 3)
        assert wait_for(lambda: camera.latest().index > first.index)
        assert camera.status()["status"] == "ok"
    finally:
        camera.stop()
    assert captures[0].released


def test_camera_asks_for_mjpg_and_the_configured_size():
    camera, captures = make_camera()
    camera.start()
    camera.stop()
    import cv2

    props = captures[0].props
    assert props[cv2.CAP_PROP_FRAME_WIDTH] == 1280
    assert props[cv2.CAP_PROP_FRAME_HEIGHT] == 720
    assert props[cv2.CAP_PROP_FOURCC] == cv2.VideoWriter.fourcc(*"MJPG")


def test_camera_that_cannot_open_raises_a_helpful_error():
    camera, _ = make_camera(opened=False)
    with pytest.raises(CameraError, match="camera 0"):
        camera.start()
    assert camera.status()["status"] == "error"


def test_camera_reopens_after_repeated_read_failures():
    camera, captures = make_camera(fail_after=5)
    camera.start()
    try:
        assert wait_for(lambda: len(captures) >= 2, timeout=3.0)
    finally:
        camera.stop()


def test_an_unexpected_driver_error_becomes_a_camera_error():
    def factory(index, backend):
        raise RuntimeError("driver exploded")

    camera = Camera(Config(warmup_seconds=0.0), capture_factory=factory)
    with pytest.raises(CameraError, match="driver exploded"):
        camera.start()
    assert camera.status()["status"] == "error"


def test_a_failing_status_listener_does_not_stop_the_camera():
    def listener(status):
        raise RuntimeError("listener bug")

    camera = Camera(
        Config(warmup_seconds=0.0),
        capture_factory=lambda index, backend: FakeCapture(index, backend),
        on_status=listener,
    )
    camera.start()
    try:
        assert wait_for(lambda: camera.latest() is not None and camera.latest().index >= 5)
    finally:
        camera.stop()
    assert camera.status()["status"] == "off"


def test_stop_releases_the_camera_from_its_own_thread():
    camera, captures = make_camera()
    camera.start()
    assert wait_for(lambda: camera.latest() is not None)
    camera.stop()
    assert all(capture.released for capture in captures)
    assert camera.status()["status"] == "off"


def test_fps_is_measured():
    camera, _ = make_camera()
    camera.start()
    try:
        assert wait_for(lambda: camera.fps > 0)
    finally:
        camera.stop()


def test_annotate_returns_a_copy_and_leaves_the_frame_alone():
    image = np.zeros((120, 200, 3), np.uint8)
    out = annotate(image, fps=29.97, label="cam 0")
    assert out is not image
    assert image.sum() == 0
    assert out.sum() > 0


def test_encode_jpeg_produces_a_jpeg():
    data = encode_jpeg(np.zeros((32, 32, 3), np.uint8))
    assert data[:2] == b"\xff\xd8"
