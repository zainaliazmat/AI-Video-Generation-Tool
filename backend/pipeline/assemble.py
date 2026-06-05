"""Stage 5 — assemble all stage outputs into a schema-valid spec.json.

CRITICAL: serialize with model_dump(by_alias=True) so kenBurns.from (not from_)
is emitted — otherwise the Remotion contract breaks.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import json
from pathlib import Path

from schema import Spec, Meta, Audio, Scene, Media, KenBurns, Caption, Style
from pipeline.frames import seconds_to_frames
from pipeline.contracts import LineOffset, WordTiming, Clip


def build_spec(title, line_offsets, word_timings, clips, *, fps: int = 30, music: str | None = None) -> Spec:
    clips_by_index = {c.index: c for c in clips}
    scenes = []
    for lo in line_offsets:
        start_f = seconds_to_frames(lo.start, fps)
        end_f = seconds_to_frames(lo.end, fps)
        clip = clips_by_index.get(lo.index)
        if clip is None:
            raise ValueError(f"No clip for scene index {lo.index}")
        scenes.append(
            Scene(
                id=f"scene-{lo.index}",
                startFrame=start_f,
                durationInFrames=max(1, end_f - start_f),
                media=Media(type="video", src=clip.path, fit="cover", kenBurns=KenBurns()),
            )
        )

    total_frames = seconds_to_frames(line_offsets[-1].end, fps) if line_offsets else 0
    captions = [
        Caption(text=w.text, startFrame=w.start_frame, endFrame=w.end_frame)
        for w in word_timings
    ]

    return Spec(
        meta=Meta(title=title, fps=fps, width=1080, height=1920, durationInFrames=total_frames),
        audio=Audio(voiceover="assets/voiceover.wav", music=music, musicVolumeDb=-18.0),
        scenes=scenes,
        captions=captions,
        style=Style(),
    )


def write_spec(spec: Spec, path) -> None:
    data = spec.model_dump(by_alias=True)
    Path(path).write_text(json.dumps(data, indent=2), encoding="utf-8")
