"""Downloading the hand-tracking model.

MediaPipe 1.x only has the Tasks API (the old `mp.solutions.hands` is gone), and
the Tasks API needs this model file on disk.

Run on its own:  uv run python -m hackcc_cv.models
"""

from __future__ import annotations

import logging
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/latest/hand_landmarker.task"
)
HAND_MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "hand_landmarker.task"
MIN_MODEL_BYTES = 1_000_000  # the real file is about 7.8 MB
DOWNLOAD_TIMEOUT_SECONDS = 60

Opener = Callable[..., Any]


class ModelError(RuntimeError):
    """The model file is missing and could not be downloaded."""


def ensure_hand_model(
    path: Path = HAND_MODEL_PATH, opener: Opener = urllib.request.urlopen
) -> Path:
    """Return the model's path, downloading it first if it is not there yet."""
    if path.exists() and path.stat().st_size >= MIN_MODEL_BYTES:
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    log.info("Downloading the hand model to %s", path)
    try:
        with opener(HAND_MODEL_URL, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            partial.write_bytes(response.read())
        size = partial.stat().st_size
        if size < MIN_MODEL_BYTES:
            raise ModelError(
                f"The hand model download looks incomplete ({size} bytes). Check the internet "
                "connection and try again."
            )
        partial.replace(path)
    except ModelError:
        partial.unlink(missing_ok=True)
        raise
    except OSError as error:
        partial.unlink(missing_ok=True)
        raise ModelError(f"Could not download the hand model: {error}") from error
    return path


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    log.info("Hand model ready: %s", ensure_hand_model())
