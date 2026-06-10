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
    # A.2a media provenance — surfaced from select_clip's real choice; None until set
    # (and for legacy pre-A.2a cached clips). Render-irrelevant: assemble ignores these.
    rank: int | None = None          # 1-based position among USABLE clips in the chosen search
    pexels_id: int | None = None     # Pexels video object id of the chosen clip
    pexels_url: str | None = None    # Pexels page url of the chosen clip


@dataclass
class FootageRequest:
    """A request for one footage clip, emitted by the recipe plan for each
    `scene`-kind beat. `min_frames` is a SOFT loop floor (half the on-screen span,
    K=2): select_clip keeps the most relevant clip that clears it, and only yields a
    pathologically short top hit to a longer usable clip below — relevance still wins
    among clips long enough to loop ≤ ~2×. `broad_query` is a broader fallback (the
    video title) tried when `query` returns no portrait clip, so a too-specific query
    degrades to a looser match instead of crashing."""
    index: int       # beat index (scene position)
    query: str
    min_frames: int = 0
    broad_query: str | None = None
