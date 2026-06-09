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

from pipeline import script as script_stage       # noqa: F401 — test patches via m.script_stage
from pipeline import tts as tts_stage             # noqa: F401 — test patches via m.tts_stage
from pipeline import timing as timing_stage       # noqa: F401 — test patches via m.timing_stage
from pipeline import footage as footage_stage     # noqa: F401 — test patches via m.footage_stage
from pipeline import assemble as assemble_stage
from pipeline import validate as validate_stage
from pipeline.contracts import FootageRequest
from pipeline.footage_query import harden
from schema import Theme

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "remotion" / "public" / "assets"
TEMPLATES_DIR = REPO_ROOT / "templates"
SPEC_OUT = REPO_ROOT / "spec.json"
SOURCES_OUT = REPO_ROOT / "sources.json"   # grounding citation sidecar (Phase 3 §5.2)
RETRIEVAL_CACHE = REPO_ROOT / ".cache" / "retrieval"   # Tavily results cached by query (cost bound)
SESSIONS_DB = REPO_ROOT / "backend" / ".sessions" / "sessions.db"
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
    from session import store, engine, executors

    def emit(key: str, state: str) -> None:
        if on_stage:
            on_stage(key, state)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    catalog = validate_stage.load_catalog(TEMPLATES_DIR)
    ctx = executors.EngineContext(
        topic=topic, fps=fps, theme=Theme(), catalog=catalog,
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=ASSETS_DIR / "voiceover.wav",
        spec_out=SPEC_OUT, sources_out=SOURCES_OUT,
    )
    conn = store.connect(SESSIONS_DB)
    sid = topic  # one session per topic in autopilot; A.6 will mint real ids
    if store.get_session(conn, sid) is None:
        store.create_session(conn, id=sid, topic=topic, now="autopilot")
    eng = engine.Engine(conn, ctx, session_id=sid)

    for key in PIPELINE_STAGES:
        emit(key, "running")
        _log(f"[{PIPELINE_STAGES.index(key) + 1}/{len(PIPELINE_STAGES)}] {key}...")
        eng.advance(key)
        emit(key, "done")
    eng.materialize_spec()

    # sources sidecar from the script stage output (unchanged Phase-3 behavior)
    script_bundle = eng._load_output("script")
    SOURCES_OUT.write_text(json.dumps(build_sources_sidecar(script_bundle["script"]), indent=2),
                           encoding="utf-8")
    spec = eng._load_output("assemble")
    _log(f"      wrote {SPEC_OUT}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
    _log(f"      wrote {SOURCES_OUT}  ({len(script_bundle['script'].sources or [])} sources cited)")
    conn.close()
    return spec


def _footage_requests(plan, offsets, catalog, fps):
    """One FootageRequest per `scene`-kind beat. `min_frames` is the loop FLOOR — HALF
    the on-screen span (scene span + widest transition), i.e. K=2: skip clips that
    would loop more than ~2× over the beat. select_clip applies it softly (relevance
    wins among clips that clear it; a too-short top hit only yields to a longer usable
    clip below). Half-span, not full span, so we don't resurrect the old bias that
    dropped the relevant top hit for a longer worse one. `broad_query` carries the
    title so fetch_footage can broaden a too-specific query that returns no clip."""
    _, durations, _ = assemble_stage.scene_spans(offsets, fps)
    headroom = max((m.durationFrames.max for m in catalog.values() if m.kind == "transition"), default=0)
    return [
        # broad_query hardening: only the Layer-A lexicon matters here (Layer B is
        # identity when query == title); a colliding title is remapped before broaden.
        FootageRequest(index=i, query=ps.query, min_frames=(durations[i] + headroom) // 2, broad_query=harden(plan.title, title=plan.title))
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
