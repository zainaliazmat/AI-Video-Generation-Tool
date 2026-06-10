"""Stage 5 — assemble a ScenePlan + audio timing + footage into a spec.json.

Step 6.4: the recipe/director (recipe.plan) decides WHICH template renders each
narration span; this stage BINDS that plan to the audio-derived timing and the
fetched footage, then emits a schema-valid, multi-template spec.

Timing invariant — GAP-FILLING contiguity: scene i spans Sᵢ → Sᵢ₊₁ (the last
scene → total), where Sᵢ is the voiceover frame of beat i. tts inserts a small
silence between lines, so the narration spans don't tile; extending each scene to
the next scene's start removes those gaps. This keeps the renderer's
<TransitionSeries> path — which lays scenes CONTIGUOUSLY and reclaims each
transition's overlap — pinned to Sᵢ (zero cumulative drift), and Σ durations ==
meta.durationInFrames. Captions/audio stay at the root on absolute frames.

Transitions: the plan emits a transition INTENT; here we resolve its duration Tᵢ
from the transition template's `durationFrames` range, clamped to ≤ min(dᵢ, dᵢ₊₁).
If even the minimum blend won't fit, it degrades to a hard cut.

Clip-length fallback: a footage scene plays its clip for dᵢ+Tᵢ frames; if the
clip is shorter, `media.loop` repeats it to fill the span (a 0-frame/unknown clip
just doesn't loop). No assert — short clips degrade gracefully.

CRITICAL: serialize with model_dump(by_alias=True) so kenBurns.from (not from_)
is emitted — otherwise the Remotion contract breaks.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import json
from pathlib import Path
from typing import Dict, Optional

from schema import Spec, Meta, Audio, Scene, Media, KenBurns, Caption, Theme, Transition
from manifest import Manifest
from pipeline.frames import seconds_to_frames
from pipeline.recipe import ScenePlan, TransitionIntent


def scene_spans(line_offsets, fps: int):
    """Gap-filling frame spans for scenes: returns (starts, durations, total)
    where scene i spans starts[i] → starts[i]+durations[i] = starts[i+1] (last →
    total). Shared by build_spec and the footage min_frames bias so they agree."""
    n = len(line_offsets)
    starts = [seconds_to_frames(o.start, fps) for o in line_offsets]
    total = seconds_to_frames(line_offsets[-1].end, fps) if line_offsets else 0
    durations = [(starts[i + 1] if i + 1 < n else total) - starts[i] for i in range(n)]
    return starts, durations, total


def _resolve_transition(
    intent: Optional[TransitionIntent], dur_i: int, dur_next: int, catalog: Dict[str, Manifest]
) -> Optional[Transition]:
    """Pick a concrete Tᵢ within the transition template's range, clamped to the
    blend that fits (≤ min(dᵢ, dᵢ₊₁)). Returns None (hard cut) when it can't fit."""
    if intent is None:
        return None
    manifest = catalog.get(intent.template)
    if manifest is None:
        return None  # unknown id -> hard cut (validate_spec reports it separately)
    fit = min(dur_i, dur_next)
    t = min(manifest.durationFrames.max, fit)
    if t < manifest.durationFrames.min:
        return None  # even the minimum blend won't fit -> hard cut
    return Transition(template=intent.template, durationInFrames=t, props=dict(intent.props))


def _scene_media(clip, span_frames: int) -> Media:
    """Footage media for a scene span. Emits the clip's media `kind` and loops iff
    it is a VIDEO known-shorter than the span the renderer plays it for (dᵢ + Tᵢ).
    Images (kind='image') carry no duration and never loop — the <Img> renders for
    the full span."""
    loop = clip.kind == "video" and clip.duration_frames is not None and clip.duration_frames < span_frames
    return Media(type=clip.kind, src=clip.path, fit="cover", kenBurns=KenBurns(), loop=loop)


def build_spec(
    plan: ScenePlan,
    line_offsets,
    word_timings,
    clips,
    *,
    catalog: Dict[str, Manifest],
    fps: int = 30,
    music: str | None = None,
    voiceover_rel: str = "assets/voiceover.wav",
) -> Spec:
    scenes_plan = plan.scenes
    n = len(scenes_plan)
    if n != len(line_offsets):
        raise ValueError(f"plan has {n} scenes but {len(line_offsets)} narration offsets")

    # Gap-filling: scene i spans Sᵢ → Sᵢ₊₁ (last → total). Contiguous, Σ == total.
    starts, durations, total = scene_spans(line_offsets, fps)
    clips_by_index = {c.index: c for c in clips}

    scenes = []
    for i, ps in enumerate(scenes_plan):
        dur_i = durations[i]
        dur_next = durations[i + 1] if i + 1 < n else dur_i
        transition = _resolve_transition(ps.transition, dur_i, dur_next, catalog)
        t_frames = transition.durationInFrames if transition else 0

        if ps.needs_footage:
            clip = clips_by_index.get(i)
            if clip is None:
                raise ValueError(f"No footage clip for scene index {i} (template {ps.template!r})")
            media = _scene_media(clip, dur_i + t_frames)
            props = {"media": media.model_dump(by_alias=True)}
        else:
            props = dict(ps.props)

        scenes.append(
            Scene(
                id=f"scene-{i}",
                startFrame=starts[i],
                durationInFrames=max(1, dur_i),
                template=ps.template,
                templateProps=props,
                transition=transition,
            )
        )

    captions = [
        Caption(text=w.text, startFrame=w.start_frame, endFrame=w.end_frame)
        for w in word_timings
    ]

    return Spec(
        meta=Meta(title=plan.title, fps=fps, width=1080, height=1920, durationInFrames=total),
        audio=Audio(voiceover=voiceover_rel, music=music, musicVolumeDb=-18.0),
        scenes=scenes,
        captions=captions,
        theme=Theme(),
    )


def write_spec(spec: Spec, path) -> None:
    data = spec.model_dump(by_alias=True)
    Path(path).write_text(json.dumps(data, indent=2), encoding="utf-8")
