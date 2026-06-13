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
    # Studio v2 seams (defaulted so existing construction is unchanged):
    voice: str = "af_heart"            # Voice gate selection (Kokoro voice id)
    speed: float = 1.0                 # Voice gate speed (0.8x-1.2x)
    extra_user_block: str = ""         # Script gate regenerate-with-feedback + style memory
    # Studio v3 M2: target video length in seconds (drives system_prompt_for preset)
    target_length: int = 60            # default 60 → system_prompt_for(60) == SYSTEM_PROMPT


def run_script(ctx: EngineContext, inputs: dict) -> dict:
    """Mirrors main.run() lines 81-84:
        script_result = script_stage.generate_grounded_script(topic, cache_dir=RETRIEVAL_CACHE)
        plan = recipe_stage.plan(script_result, theme=theme, manifests=catalog)
    `inputs` is unused — script is the source stage with no upstream deps.
    `ctx.extra_user_block` (Studio v2) injects style memory + regenerate feedback as
    an additive USER-prompt block; empty by default → byte-identical to a plain run.
    `ctx.target_length` (Studio v3 M2) selects the system prompt preset via
    system_prompt_for(); default 60 → system_prompt_for(60) == SYSTEM_PROMPT (golden).
    """
    # Pass extra_user_block ONLY when set, so the default call is byte-identical to
    # the pre-Studio-v2 signature (keeps existing stage stubs valid).
    kw = {"extra_user_block": ctx.extra_user_block} if ctx.extra_user_block else {}
    # pass system_prompt only for non-default presets: at 60 it's byte-identical to
    # SYSTEM_PROMPT, and omitting it keeps existing call signatures (and test stubs
    # without **kw) stable.
    system_prompt = script_stage.system_prompt_for(ctx.target_length)
    if system_prompt != script_stage.SYSTEM_PROMPT:
        kw["system_prompt"] = system_prompt
    # M2-T3: always pass target_length so the unified band+parse retry is active.
    kw["target_length"] = ctx.target_length
    script = script_stage.generate_grounded_script(ctx.topic, cache_dir=ctx.cache_dir, **kw)
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
    # Pass voice/speed ONLY when non-default so existing voice-stage stubs (which
    # patch tts_stage.synthesize with a 2-arg lambda) stay valid.
    kw = {}
    if ctx.voice and ctx.voice != tts_stage.DEFAULT_VOICE:
        kw["voice"] = ctx.voice
    if ctx.speed and ctx.speed != 1.0:
        kw["speed"] = ctx.speed
    return tts_stage.synthesize(lines, ctx.voiceover_path, **kw)


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

    v3 M5 (D4 + OV-6): pools are fetched for ALL scenes that carry a query — heroes
    (hook/outro) included. Heroes: pool fetched + cached, NOTHING downloads
    (needs_footage stays False). The per-hardened-query pool cache
    (ctx.cache_dir / footage_pools/) makes repeated queries free (zero network calls).
    A 429 exhaustion records pool=[] + pool_error="rate_limited" for that scene
    instead of crashing (OV-6 honesty).
    """
    plan = inputs["script"]["plan"]
    offsets = inputs["voice"]
    reqs = _footage_requests(ctx, plan, offsets)
    clips = footage_stage.fetch_footage(reqs, ctx.assets_dir, fps=ctx.fps)
    chosen = {c.index: (c.query, c.rank) for c in clips}

    # Build the pool for every scene that has a query — footage scenes AND heroes.
    # `candidates` stays {scene_index: [rows]} (list) so _sync_footage_candidates_to_db
    # and _edit_footage read it without changes.  Structured error state (OV-6) goes
    # into a separate `pool_errors` dict: {scene_index: error_str} so downstream
    # stages that don't know about errors continue to see a list (possibly empty).
    candidates: dict = {}
    pool_errors: dict = {}
    try:
        key = footage_stage.require_env("PEXELS_API_KEY")
    except Exception:
        key = None

    for i, ps in enumerate(plan.scenes):
        if not ps.query:
            continue  # stat / enumeration / no-query scenes: no pool
        pool_result = {"rows": [], "error": "fetch_error"}
        if key:
            pool_result = footage_stage.fetch_pool(
                ps.query, key, ctx.fps, cache_dir=ctx.cache_dir)
        rows = pool_result["rows"]
        pool_error = pool_result.get("error")

        for row in rows:
            if ps.needs_footage:
                # EXACT initial selection: mark the row matching the clip's real (query, rank)
                # from A.2a provenance — so a K-floor displacement to rank>1 rings the clip
                # that was actually bound, not rank-1. No row is marked when fetch_footage
                # broadened a whiffing query to the title (the pool is the specific query,
                # the clip came from the broadened one) or for legacy clips with rank=None.
                # The gate's pick/re_query ops still set `selected` precisely on edit.
                q, rank = chosen.get(i, (None, None))
                row["selected"] = 1 if (row["query"] == q and rank is not None
                                        and row["rank"] == rank) else 0
            else:
                # Hero scenes: pool stored, never selected (no clip downloaded)
                row["selected"] = 0
            row["clip_path"] = None

        candidates[i] = rows
        if pool_error:
            # OV-6 honesty: record the error marker alongside the (empty) pool
            pool_errors[i] = pool_error

    return {"clips": clips, "candidates": candidates, "pool_errors": pool_errors}


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
        plan, offsets, words, clips, catalog=ctx.catalog, fps=ctx.fps,
        voiceover_rel=f"assets/{ctx.voiceover_path.name}",
    )
