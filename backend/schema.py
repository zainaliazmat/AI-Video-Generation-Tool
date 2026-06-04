"""Pydantic models for the spec.json contract.

This is one of the two definitions of the data contract between the backend
(Python) and the renderer (Remotion/TS). It MUST stay identical in shape to
`remotion/src/schema.ts`. All timing is in FRAMES (fps lives in `meta`).

Run as a script to validate a spec file (requires pydantic, installed in Phase 4):
    python3 backend/schema.py sample-spec.json
"""
from __future__ import annotations

from typing import List, Literal, Optional

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


class Scene(BaseModel):
    id: str
    startFrame: int
    durationInFrames: int
    media: Media


class Caption(BaseModel):
    text: str
    startFrame: int
    endFrame: int


class Style(BaseModel):
    captionFontFamily: str = "Inter"
    captionFontWeight: int = 800
    captionColor: str = "#FFFFFF"
    captionHighlightColor: str = "#FFE600"   # color of the word currently spoken
    captionStrokeColor: str = "#000000"
    captionPositionY: float = 0.78           # 0 = top, 1 = bottom


class Spec(BaseModel):
    meta: Meta
    audio: Audio
    scenes: List[Scene]
    captions: List[Caption]
    style: Style


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
        f"{spec.meta.durationInFrames} frames @ {spec.meta.fps}fps "
        f"({spec.meta.width}x{spec.meta.height})"
    )
