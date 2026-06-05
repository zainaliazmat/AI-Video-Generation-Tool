"""Seconds -> frames conversion. All spec timing is in frames; fps lives in meta."""
from __future__ import annotations


def seconds_to_frames(seconds: float, fps: int) -> int:
    if seconds < 0:
        raise ValueError(f"seconds must be >= 0, got {seconds}")
    return round(seconds * fps)
