"""Stage executors: a uniform run(ctx, inputs)->output over the existing, proven
stage functions. `inputs` is {dep_stage: that stage's deserialized output}. These
do NOT reimplement stage logic — they thread the EngineContext + upstream outputs
into the same calls main.run() made."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pipeline import script as script_stage
from pipeline import tts as tts_stage
from pipeline import timing as timing_stage
from pipeline import footage as footage_stage
from pipeline import assemble as assemble_stage
from pipeline import recipe as recipe_stage
from pipeline.contracts import FootageRequest
from pipeline.footage_query import harden
from schema import Theme


@dataclass(frozen=True)
class EngineContext:
    """Immutable per-job configuration threaded into every stage executor. Frozen so
    an executor can never accidentally stomp a field that a downstream stage reads."""
    topic: str
    fps: int
    theme: Theme
    catalog: dict
    assets_dir: Path
    cache_dir: Path
    voiceover_path: Path
    spec_out: Path
    sources_out: Path


def run_script(ctx: EngineContext, inputs: dict) -> dict:
    """Mirrors main.run() lines 81-84:
        script_result = script_stage.generate_grounded_script(topic, cache_dir=RETRIEVAL_CACHE)
        plan = recipe_stage.plan(script_result, theme=theme, manifests=catalog)
    `inputs` is unused — script is the source stage with no upstream deps.
    """
    script = script_stage.generate_grounded_script(ctx.topic, cache_dir=ctx.cache_dir)
    plan = recipe_stage.plan(script, theme=ctx.theme, manifests=ctx.catalog)
    return {"script": script, "plan": plan}


def run_voice(ctx: EngineContext, inputs: dict) -> list:
    """Mirrors main.run() lines 86, 93:
        lines = [b.text for b in script_result.beats]
        offsets = tts_stage.synthesize(lines, voiceover)
    voiceover is a Path in main.run(); ctx.voiceover_path is a Path — passed as-is.
    """
    script = inputs["script"]["script"]
    lines = [b.text for b in script.beats]
    return tts_stage.synthesize(lines, ctx.voiceover_path)


def run_timing(ctx: EngineContext, inputs: dict) -> list:
    """Mirrors main.run() line 98:
        words = timing_stage.transcribe_words(str(voiceover), fps)
    str() cast is intentional — matches main.run() exactly.
    """
    return timing_stage.transcribe_words(str(ctx.voiceover_path), ctx.fps)


def _footage_requests(ctx: EngineContext, plan, offsets: list) -> list:
    """Mirrors main.run()'s _footage_requests(plan, offsets, catalog, fps) exactly:
        _, durations, _ = assemble_stage.scene_spans(offsets, fps)
        headroom = max((m.durationFrames.max for m in catalog.values()
                        if m.kind == "transition"), default=0)
        FootageRequest(index=i, query=ps.query,
                       min_frames=(durations[i] + headroom) // 2,
                       broad_query=harden(plan.title, title=plan.title))
        for i, ps in enumerate(plan.scenes) if ps.needs_footage
    """
    _, durations, _ = assemble_stage.scene_spans(offsets, ctx.fps)
    headroom = max(
        (m.durationFrames.max for m in ctx.catalog.values() if m.kind == "transition"),
        default=0,
    )
    return [
        FootageRequest(
            index=i,
            query=ps.query,
            min_frames=(durations[i] + headroom) // 2,
            broad_query=harden(plan.title, title=plan.title),
        )
        for i, ps in enumerate(plan.scenes)
        if ps.needs_footage
    ]


def run_footage(ctx: EngineContext, inputs: dict) -> dict:
    """Mirrors main.run() line 104:
        clips = footage_stage.fetch_footage(
            _footage_requests(plan, offsets, catalog, fps), ASSETS_DIR, fps=fps)
    ASSETS_DIR maps to ctx.assets_dir (Path); fps= keyword matches.

    The candidate pool is auxiliary (for the HITL gate). Record it best-effort:
    a missing PEXELS_API_KEY or a search failure yields an empty pool for the
    scene WITHOUT failing the footage stage (clips already came from fetch_footage).
    """
    plan = inputs["script"]["plan"]
    offsets = inputs["voice"]
    reqs = _footage_requests(ctx, plan, offsets)
    clips = footage_stage.fetch_footage(reqs, ctx.assets_dir, fps=ctx.fps)
    selected_query = {c.index: c.query for c in clips}
    candidates = {}
    for r in reqs:
        # Best-effort (see docstring): a missing key / search failure -> empty pool.
        try:
            key = footage_stage.require_env("PEXELS_API_KEY")
            data = footage_stage.search_pexels(r.query, key)
            rows = footage_stage.candidate_rows(data.get("videos", []), query=r.query, fps=ctx.fps)
        except Exception:
            rows = []
        for row in rows:
            # APPROXIMATE initial selection: mark rank-1 of the matching query. If
            # fetch_footage's K-floor picked rank>1 (rank-1 too short to clear the loop
            # floor), no row is marked here — the Clip doesn't expose which candidate it
            # chose. Exact tracking is deferred to A.6; the gate's pick/re_query ops set
            # `selected` precisely on edit.
            row["selected"] = 1 if (row["query"] == selected_query.get(r.index)
                                    and row["rank"] == 1) else 0
            row["clip_path"] = None
        candidates[r.index] = rows
    return {"clips": clips, "candidates": candidates}


def run_assemble(ctx: EngineContext, inputs: dict) -> Any:
    """Mirrors main.run() line 109:
        spec = assemble_stage.build_spec(
            plan, offsets, words, clips, catalog=catalog, fps=fps)
    All kwargs match exactly.
    """
    plan = inputs["script"]["plan"]
    offsets = inputs["voice"]
    words = inputs["timing"]
    clips = inputs["footage"]["clips"]
    return assemble_stage.build_spec(
        plan, offsets, words, clips, catalog=ctx.catalog, fps=ctx.fps
    )
