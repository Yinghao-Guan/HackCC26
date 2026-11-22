"""Settings for the CV service, from environment variables and the command line.

Command-line flags win over environment variables, which win over the defaults.
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

BACKENDS = ("dshow", "msmf", "any")
DEFAULT_DATA_DIR = Path(__file__).resolve().parents[1] / "data"

DEFAULT_ORIGINS = (
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
)


class ConfigError(ValueError):
    """A setting has a value we cannot use."""


@dataclass(frozen=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8765
    camera_enabled: bool = True
    camera_index: int = 0
    # dshow is the most reliable on Windows; msmf can return black frames at first.
    camera_backend: str = "dshow"
    width: int = 1280
    height: int = 720
    fps: int = 30
    # Frames to throw away after opening, while exposure settles.
    warmup_seconds: float = 1.0
    # Publish a made-up finger so the UI and AI roles can work without a camera.
    fake_pointer: bool = False
    # Hand tracking and gestures (needs the camera and the hand model).
    gestures: bool = True
    # Recalibrate by itself when the printed markers show the camera moved.
    auto_recalibrate: bool = True
    # Browser pages allowed to open the WebSocket. Tools without an Origin header are allowed.
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS
    # Where calibrations are saved (git-ignored; per machine and setup).
    data_dir: Path = field(default=DEFAULT_DATA_DIR)


def _int(name: str, raw: str, low: int, high: int) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}.") from error
    if not low <= value <= high:
        raise ConfigError(f"{name} must be between {low} and {high}, got {value}.")
    return value


def _bool(name: str, raw: str) -> bool:
    lowered = raw.strip().lower()
    if lowered in ("1", "true", "yes", "on"):
        return True
    if lowered in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{name} must be 1 or 0, got {raw!r}.")


def _backend(name: str, raw: str) -> str:
    lowered = raw.strip().lower()
    if lowered not in BACKENDS:
        raise ConfigError(f"{name} must be one of {', '.join(BACKENDS)}, got {raw!r}.")
    return lowered


def _from_env(env: Mapping[str, str]) -> dict[str, Any]:
    readers = {
        "CV_HOST": ("host", lambda n, r: r.strip()),
        "CV_PORT": ("port", lambda n, r: _int(n, r, 1, 65535)),
        "CV_CAMERA": ("camera_enabled", _bool),
        "CV_CAMERA_INDEX": ("camera_index", lambda n, r: _int(n, r, 0, 31)),
        "CV_CAMERA_BACKEND": ("camera_backend", _backend),
        "CV_WIDTH": ("width", lambda n, r: _int(n, r, 160, 7680)),
        "CV_HEIGHT": ("height", lambda n, r: _int(n, r, 120, 4320)),
        "CV_FPS": ("fps", lambda n, r: _int(n, r, 1, 240)),
        "CV_FAKE_POINTER": ("fake_pointer", _bool),
        "CV_GESTURES": ("gestures", _bool),
        "CV_AUTO_RECALIBRATE": ("auto_recalibrate", _bool),
        "CV_DATA_DIR": ("data_dir", lambda n, r: Path(r.strip())),
        "CV_ALLOWED_ORIGINS": (
            "allowed_origins",
            lambda n, r: tuple(o.strip() for o in r.split(",") if o.strip()),
        ),
    }
    values: dict[str, Any] = {}
    for env_name, (attr, read) in readers.items():
        if env_name in env:
            values[attr] = read(env_name, env[env_name])
    return values


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m hackcc_cv", description=__doc__)
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--camera", type=int, dest="camera_index", help="camera index (see probe)")
    parser.add_argument("--backend", choices=BACKENDS, dest="camera_backend")
    parser.add_argument("--width", type=int)
    parser.add_argument("--height", type=int)
    parser.add_argument("--fake", action="store_true", help="publish a fake finger")
    parser.add_argument("--no-camera", action="store_true", help="run without opening a camera")
    parser.add_argument("--no-gestures", action="store_true", help="no hand tracking or gestures")
    parser.add_argument("--no-auto-recalibrate", action="store_true", help="only warn when the camera moves")
    return parser


def load_config(
    env: Mapping[str, str] | None = None, argv: Sequence[str] | None = None
) -> Config:
    """Build the settings. Raises ConfigError with a readable message on bad input."""
    config = replace(Config(), **_from_env(os.environ if env is None else env))

    args = _parser().parse_args(list(argv) if argv is not None else None)
    overrides: dict[str, Any] = {
        key: value
        for key, value in vars(args).items()
        if key not in ("fake", "no_camera", "no_gestures", "no_auto_recalibrate") and value is not None
    }
    if args.fake:
        overrides["fake_pointer"] = True
    if args.no_camera:
        overrides["camera_enabled"] = False
    if args.no_gestures:
        overrides["gestures"] = False
    if args.no_auto_recalibrate:
        overrides["auto_recalibrate"] = False

    # Re-check numbers that came from the command line the same way as env values.
    for attr, name, low, high in (
        ("port", "--port", 1, 65535),
        ("camera_index", "--camera", 0, 31),
        ("width", "--width", 160, 7680),
        ("height", "--height", 120, 4320),
    ):
        if attr in overrides:
            overrides[attr] = _int(name, str(overrides[attr]), low, high)

    return replace(config, **overrides)
