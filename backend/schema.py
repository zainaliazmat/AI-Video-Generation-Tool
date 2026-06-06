"""Pydantic models for the spec.json contract.

This is one of the two definitions of the data contract between the backend
(Python) and the renderer (Remotion/TS). It MUST stay identical in shape to
`remotion/src/schema.ts`. All timing is in FRAMES (fps lives in `meta`).

Run as a script to validate a spec file (requires pydantic, installed in Phase 4):
    python3 backend/schema.py sample-spec.json
"""
from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Meta(BaseModel):
    title: str
    fps: int = 30
    width: int = 1080
    height: int = 1920
    durationInFrames: int


class Audio(BaseModel):
    voiceover: str                      # path relative to remotion/public/
    music: Optional[str] = None         # null if none
    musicVolumeDb: float = -18.0        # ducked under the voice


class KenBurns(BaseModel):
    # `from` is a Python keyword, so we expose it as `from_` with a JSON alias.
    model_config = ConfigDict(populate_by_name=True)

    from_: float = Field(default=1.0, alias="from")
    to: float = 1.12
    originX: float = 0.5
    originY: float = 0.5


class Media(BaseModel):
    type: Literal["video", "image"]
    src: str                            # path relative to remotion/public/
    fit: Literal["cover", "contain"] = "cover"
    kenBurns: Optional[KenBurns] = None


class Transition(BaseModel):
    """A transition leading OUT of a scene into the next one (references a
    `transition`-kind template). Ignored on the final scene."""
    template: str                       # id of a transition-kind template
    durationInFrames: int
    props: Dict = Field(default_factory=dict)


class Scene(BaseModel):
    id: str
    startFrame: int
    durationInFrames: int
    # A template-driven scene carries its content in `templateProps` (validated
    # against the template's inputSchema in a later step). `media` is optional —
    # the `scene` template puts its footage in templateProps; non-media templates
    # (e.g. a stat callout) have neither.
    template: Optional[str] = None
    templateProps: Optional[Dict] = None
    media: Optional[Media] = None
    transition: Optional[Transition] = None  # transition OUT of this scene


class Caption(BaseModel):
    text: str
    startFrame: int
    endFrame: int


class Layer(BaseModel):
    """An overlay composited on top of the scenes (an `overlay`-kind template,
    e.g. Lottie or transparent video). Overlay-only this phase; captions remain
    a dedicated top-level field and graduate into this model later."""
    id: str
    template: str                       # id of an overlay-kind template
    startFrame: int
    durationInFrames: int
    props: Dict = Field(default_factory=dict)


class Palette(BaseModel):
    background: str = "#000000"
    foreground: str = "#FFFFFF"
    accent: str = "#FFE600"
    muted: str = "#9CA3AF"


class Fonts(BaseModel):
    heading: str = "Inter"
    body: str = "Inter"


class CaptionStyle(BaseModel):
    # Was the top-level `Style`; now nested under theme.caption (the `caption`
    # field prefix is dropped since it's redundant under .caption).
    fontFamily: str = "Inter"
    fontWeight: int = 800
    color: str = "#FFFFFF"
    highlightColor: str = "#FFE600"     # color of the word currently spoken
    strokeColor: str = "#000000"
    positionY: float = 0.78             # 0 = top, 1 = bottom


class Theme(BaseModel):
    """Resolved look of a video, separate from templates so any template
    re-themes without code changes."""
    palette: Palette = Field(default_factory=Palette)
    fonts: Fonts = Field(default_factory=Fonts)
    transition: str = "fade"            # default transition style name
    caption: CaptionStyle = Field(default_factory=CaptionStyle)


class Spec(BaseModel):
    meta: Meta
    audio: Audio
    scenes: List[Scene]
    captions: List[Caption]
    theme: Theme = Field(default_factory=Theme)
    layers: List[Layer] = Field(default_factory=list)


if __name__ == "__main__":
    import json
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "sample-spec.json"
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    spec = Spec.model_validate(data)
    print(
        f"OK: {path} is a valid Spec — "
        f"{len(spec.scenes)} scenes, {len(spec.captions)} captions, "
        f"{len(spec.layers)} layers, "
        f"{spec.meta.durationInFrames} frames @ {spec.meta.fps}fps "
        f"({spec.meta.width}x{spec.meta.height})"
    )
