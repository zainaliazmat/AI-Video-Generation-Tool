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
import uuid
from datetime import datetime
from pathlib import Path

from pipeline import script as script_stage       # noqa: F401 — test patches via m.script_stage
from pipeline import tts as tts_stage             # noqa: F401 — test patches via m.tts_stage
from pipeline import timing as timing_stage       # noqa: F401 — test patches via m.timing_stage
from pipeline import footage as footage_stage     # noqa: F401 — test patches via m.footage_stage
from pipeline import validate as validate_stage
from pipeline import projects as projects_mod
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


# Re-export for backward compat: tests import m.build_sources_sidecar directly.
build_sources_sidecar = projects_mod.build_sources_sidecar


def run(topic: str, fps: int = DEFAULT_FPS, on_stage=None):
    from session import store, engine, executors

    def emit(key: str, state: str) -> None:
        if on_stage:
            on_stage(key, state)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    catalog = validate_stage.load_catalog(TEMPLATES_DIR)
    now = datetime.now()
    sid = f"auto-{uuid.uuid4().hex}"
    ctx = executors.EngineContext(
        topic=topic, fps=fps, theme=Theme(), catalog=catalog,
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=ASSETS_DIR / projects_mod.voiceover_name(sid),
        spec_out=projects_mod.project_spec_path(REPO_ROOT, sid),
        sources_out=projects_mod.project_sources_path(REPO_ROOT, sid),
    )
    conn = store.connect(SESSIONS_DB)
    try:
        store.create_session(conn, id=sid, topic=topic, now="autopilot")
        eng = engine.Engine(conn, ctx, session_id=sid)
        emit("session", sid)
        projects_mod.bootstrap(REPO_ROOT, sid, topic=topic)  # register in Project Library (ruling 2A)

        for i, key in enumerate(PIPELINE_STAGES, start=1):
            emit(key, "running")
            _log(f"[{i}/{len(PIPELINE_STAGES)}] {key}...")
            eng.advance(key)
            emit(key, "done")
        eng.materialize_spec()   # writes projects/<sid>/spec.json (ctx.spec_out)

        script_bundle = eng._load_output("script")
        projects_mod.write_sources(REPO_ROOT, sid, script_bundle["script"])
        spec = eng._load_output("assemble")
        projects_mod.write_meta(REPO_ROOT, sid, meta={
            "id": sid,
            "topic": topic,
            "title": spec.meta.title,
            "createdAt": int(now.timestamp() * 1000),
            "durationInFrames": spec.meta.durationInFrames,
            "fps": spec.meta.fps,
        })
        _log(f"      wrote {ctx.spec_out}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
        return spec
    finally:
        conn.close()


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
