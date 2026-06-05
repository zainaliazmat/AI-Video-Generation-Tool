import pytest
from pipeline.config import require_env, get_env


def test_require_env_missing_raises():
    with pytest.raises(RuntimeError) as exc:
        require_env("DEFINITELY_MISSING_VAR_XYZ")
    assert "DEFINITELY_MISSING_VAR_XYZ" in str(exc.value)


def test_get_env_returns_default():
    assert get_env("DEFINITELY_MISSING_VAR_XYZ", "fallback") == "fallback"


def test_require_env_reads_set_value(monkeypatch):
    monkeypatch.setenv("SOME_TEST_VAR", "  hello  ")
    assert require_env("SOME_TEST_VAR") == "hello"
