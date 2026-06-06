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
    index: int  # beat index (scene position) this clip belongs to
    query: str
    path: str  # relative to remotion/public/, e.g. "assets/footage_ab12cd34.mp4"
    duration_frames: int | None = None  # clip length; None if unknown (no loop fallback)


@dataclass
class FootageRequest:
    """A request for one footage clip, emitted by the recipe plan for each
    `scene`-kind beat. `min_frames` is retained for a future duration floor (it no
    longer gates selection — relevance wins, a short clip loops). `broad_query` is a
    broader fallback (the video title) tried when `query` returns no portrait clip,
    so a too-specific query degrades to a looser match instead of crashing."""
    index: int       # beat index (scene position)
    query: str
    min_frames: int = 0
    broad_query: str | None = None
