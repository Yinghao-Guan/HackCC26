import io

import pytest

from hackcc_cv.models import MIN_MODEL_BYTES, ModelError, ensure_hand_model


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def test_existing_model_is_not_downloaded_again(tmp_path):
    path = tmp_path / "hand.task"
    path.write_bytes(b"x" * MIN_MODEL_BYTES)

    def opener(url, timeout):
        raise AssertionError("should not download")

    assert ensure_hand_model(path, opener=opener) == path


def test_missing_model_is_downloaded(tmp_path):
    path = tmp_path / "models" / "hand.task"
    payload = b"m" * MIN_MODEL_BYTES

    def opener(url, timeout):
        assert url.startswith("https://")
        return FakeResponse(payload)

    assert ensure_hand_model(path, opener=opener) == path
    assert path.read_bytes() == payload


def test_a_truncated_download_is_rejected_and_not_kept(tmp_path):
    path = tmp_path / "hand.task"

    def opener(url, timeout):
        return FakeResponse(b"tiny")

    with pytest.raises(ModelError):
        ensure_hand_model(path, opener=opener)
    assert not path.exists()
    assert not list(tmp_path.glob("*.part"))
