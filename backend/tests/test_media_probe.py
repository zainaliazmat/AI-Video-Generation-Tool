"""A.2b — media_probe: extension → kind, and a fail-loud injectable ffprobe duration.
No real subprocess runs here; the runner is faked."""
import types
from pathlib import Path

import pytest

from pipeline import media_probe


def _runner(*, returncode=0, stdout="", stderr=""):
    def run(cmd, capture_output=True, text=True):
        return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)
    return run


def test_kind_from_extension_video_image_and_unsupported():
    assert media_probe.kind_from_extension("a/b/clip.MP4") == "video"
    assert media_probe.kind_from_extension("photo.JPG") == "image"
    assert media_probe.kind_from_extension("x.png") == "image"
    assert media_probe.kind_from_extension(Path("clip.mp4")) == "video"
    with pytest.raises(ValueError, match="unsupported upload extension"):
        media_probe.kind_from_extension("notes.txt")


def test_slug_lowercases_and_hyphenates():
    assert media_probe.slug("Beach Sunset!!") == "beach-sunset"
    assert media_probe.slug("___") == "upload"  # empty → safe fallback


def test_ffprobe_returns_seconds_for_ok_runner():
    dur = media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="3.5\n"))
    assert dur == 3.5


def test_ffprobe_fails_loud_on_nonzero_exit():
    with pytest.raises(RuntimeError, match="ffprobe failed"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(returncode=1, stderr="boom"))


def test_ffprobe_fails_loud_on_empty_output():
    with pytest.raises(RuntimeError, match="unparseable duration"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="   \n"))


def test_ffprobe_fails_loud_on_unparseable_output():
    with pytest.raises(RuntimeError, match="unparseable duration"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="N/A"))


def test_ffprobe_fails_loud_on_nonpositive_duration():
    with pytest.raises(RuntimeError, match="non-positive duration"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="0\n"))


def test_ffprobe_fails_loud_on_missing_binary():
    def boom(cmd, capture_output=True, text=True):
        raise FileNotFoundError("ffprobe")
    with pytest.raises(RuntimeError, match="ffprobe not available"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=boom)
