import pytest
from pipeline.frames import seconds_to_frames


def test_whole_seconds():
    assert seconds_to_frames(2.0, 30) == 60


def test_zero():
    assert seconds_to_frames(0.0, 30) == 0


def test_rounds_to_nearest():
    assert seconds_to_frames(1.04, 30) == 31   # 31.2 -> 31
    assert seconds_to_frames(1.06, 30) == 32   # 31.8 -> 32


def test_negative_raises():
    with pytest.raises(ValueError):
        seconds_to_frames(-0.1, 30)
