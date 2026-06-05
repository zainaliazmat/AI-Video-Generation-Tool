"""Lightweight data passed between pipeline stages (not the spec.json contract)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class LineOffset:
    index: int
    text: str
    start: float  # seconds, inclusive
    end: float    # seconds, exclusive


@dataclass
class WordTiming:
    text: str
    start_frame: int
    end_frame: int


@dataclass
class Clip:
    index: int
    query: str
    path: str  # relative to remotion/public/, e.g. "assets/footage_ab12cd34.mp4"
