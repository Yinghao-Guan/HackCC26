import pytest

from hackcc_cv.config import Config, ConfigError, load_config


def test_defaults_bind_to_localhost_with_camera_on_and_fake_off():
    config = load_config(env={}, argv=[])
    assert config == Config()
    assert config.host == "127.0.0.1"
    assert config.port == 8765
    assert config.camera_enabled is True
    assert config.fake_pointer is False


def test_environment_overrides_defaults():
    env = {
        "CV_PORT": "9000",
        "CV_CAMERA_INDEX": "2",
        "CV_CAMERA_BACKEND": "msmf",
        "CV_WIDTH": "1920",
        "CV_HEIGHT": "1080",
        "CV_FAKE_POINTER": "1",
        "CV_CAMERA": "0",
    }
    config = load_config(env=env, argv=[])
    assert config.port == 9000
    assert config.camera_index == 2
    assert config.camera_backend == "msmf"
    assert (config.width, config.height) == (1920, 1080)
    assert config.fake_pointer is True
    assert config.camera_enabled is False


def test_command_line_overrides_environment():
    config = load_config(
        env={"CV_PORT": "9000", "CV_CAMERA_INDEX": "2"},
        argv=["--port", "9100", "--camera", "1", "--fake", "--no-camera"],
    )
    assert config.port == 9100
    assert config.camera_index == 1
    assert config.fake_pointer is True
    assert config.camera_enabled is False


@pytest.mark.parametrize(
    "env",
    [
        {"CV_PORT": "abc"},
        {"CV_PORT": "70000"},
        {"CV_CAMERA_INDEX": "-1"},
        {"CV_CAMERA_BACKEND": "v4l9"},
        {"CV_WIDTH": "0"},
        {"CV_FPS": "500"},
        {"CV_FAKE_POINTER": "maybe"},
    ],
)
def test_invalid_values_fail_with_a_clear_error(env):
    with pytest.raises(ConfigError):
        load_config(env=env, argv=[])


def test_allowed_origins_come_from_a_comma_separated_list():
    config = load_config(env={"CV_ALLOWED_ORIGINS": "http://a.test, http://b.test"}, argv=[])
    assert config.allowed_origins == ("http://a.test", "http://b.test")
