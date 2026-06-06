"""Faceless video generator — pipeline orchestrator.

Usage:  python backend/main.py --topic "3 facts about deep sea creatures"
Runs: script -> tts -> timing -> footage -> assemble, writing spec.json at the repo root.

--progress-json emits one machine-readable line per stage transition to stdout:
    PROGRESS {"stage": "script", "state": "running"}
so the preview's /api/generate route can drive the live stepper. Human logs go to
stderr, keeping stdout clean for the parser.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import argparse
import json
from pathlib import Path

from pipeline import script as script_stage
from pipeline import tts as tts_stage
from pipeline import timing as timing_stage
from pipeline import footage as footage_stage
from pipeline import assemble as assemble_stage
from pipeline import recipe as recipe_stage
from pipeline import validate as validate_stage
from pipeline.contracts import FootageRequest
from schema import Theme

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "remotion" / "public" / "assets"
TEMPLATES_DIR = REPO_ROOT / "templates"
SPEC_OUT = REPO_ROOT / "spec.json"
SOURCES_OUT = REPO_ROOT / "sources.json"   # grounding citation sidecar (Phase 3 §5.2)
RETRIEVAL_CACHE = REPO_ROOT / ".cache" / "retrieval"   # Tavily results cached by query (cost bound)
DEFAULT_FPS = 30

# Stage keys match the preview's PipelineStepper (script -> voice -> ... -> assemble).
PIPELINE_STAGES = ["script", "voice", "timing", "footage", "assemble"]


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def build_sources_sidecar(script) -> dict:
    """The client-facing citation list derived from a grounded BeatsScript: each
    cited (sourced) beat with its URL, plus the de-duped source list. Written next
    to spec.json so sources surface for clients WITHOUT touching the render contract
    (Phase 3 §5.2 — sidecar over render-contract churn)."""
    facts = [{"text": b.text, "source": b.source} for b in script.beats if b.source]
    sources = [{"url": s.url, "title": s.title} for s in (script.sources or [])]
    hooks = [
        {"text": h.text, "pattern": h.pattern, "score": h.score, "chosen": h.chosen}
        for h in (script.hook_candidates or [])
    ]
    return {
        "title": script.title,
        "hooks": hooks,
        "facts": facts,
        "sources": sources,
        "verification": script.verify_report or [],
    }


def run(topic: str, fps: int = DEFAULT_FPS, on_stage=None):
    def emit(key: str, state: str) -> None:
        if on_stage:
            on_stage(key, state)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    voiceover = ASSETS_DIR / "voiceover.wav"
    catalog = validate_stage.load_catalog(TEMPLATES_DIR)
    theme = Theme()

    emit("script", "running")
    _log("[1/5] script (grounded LLM) + recipe plan...")
    script_result = script_stage.generate_grounded_script(topic, cache_dir=RETRIEVAL_CACHE)
    # The recipe/director (deterministic) decides which template renders each
    # beat. Fast + local, so it folds into the script stage.
    plan = recipe_stage.plan(script_result, theme=theme)
    # Every beat is narrated; tts/captions key off the narration text in order.
    lines = [b.text for b in script_result.beats]
    roles = [s.role for s in plan.scenes]
    _log(f"      title={script_result.title!r}  beats={len(lines)}  plan={roles}")
    emit("script", "done")

    emit("voice", "running")
    _log("[2/5] tts (Kokoro)...")
    offsets = tts_stage.synthesize(lines, voiceover)
    emit("voice", "done")

    emit("timing", "running")
    _log("[3/5] timing (faster-whisper)...")
    words = timing_stage.transcribe_words(str(voiceover), fps)
    _log(f"      {len(words)} words timed")
    emit("timing", "done")

    emit("footage", "running")
    _log("[4/5] footage (Pexels)...")
    clips = footage_stage.fetch_footage(_footage_requests(plan, offsets, catalog, fps), ASSETS_DIR, fps=fps)
    emit("footage", "done")

    emit("assemble", "running")
    _log("[5/5] assemble -> validate -> spec.json...")
    spec = assemble_stage.build_spec(plan, offsets, words, clips, catalog=catalog, fps=fps)
    validate_stage.validate_spec(spec, catalog)  # fail fast before writing
    assemble_stage.write_spec(spec, SPEC_OUT)
    SOURCES_OUT.write_text(json.dumps(build_sources_sidecar(script_result), indent=2), encoding="utf-8")
    _log(f"      wrote {SPEC_OUT}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
    _log(f"      wrote {SOURCES_OUT}  ({len(script_result.sources or [])} sources cited)")
    emit("assemble", "done")
    return spec


def _footage_requests(plan, offsets, catalog, fps):
    """One FootageRequest per `scene`-kind beat, biased to a clip long enough to
    cover the scene span plus the widest possible transition (so the loop
    fallback rarely fires)."""
    _, durations, _ = assemble_stage.scene_spans(offsets, fps)
    headroom = max((m.durationFrames.max for m in catalog.values() if m.kind == "transition"), default=0)
    return [
        FootageRequest(index=i, query=ps.query, min_frames=durations[i] + headroom)
        for i, ps in enumerate(plan.scenes)
        if ps.needs_footage
    ]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS)
    ap.add_argument("--progress-json", action="store_true",
                    help="emit machine-readable PROGRESS lines to stdout")
    args = ap.parse_args()

    on_stage = None
    if args.progress_json:
        def on_stage(key: str, state: str) -> None:
            print(f"PROGRESS {json.dumps({'stage': key, 'state': state})}", flush=True)

    run(args.topic, args.fps, on_stage=on_stage)
