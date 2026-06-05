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

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "remotion" / "public" / "assets"
SPEC_OUT = REPO_ROOT / "spec.json"
DEFAULT_FPS = 30

# Stage keys match the preview's PipelineStepper (script -> voice -> ... -> assemble).
PIPELINE_STAGES = ["script", "voice", "timing", "footage", "assemble"]


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def run(topic: str, fps: int = DEFAULT_FPS, on_stage=None):
    def emit(key: str, state: str) -> None:
        if on_stage:
            on_stage(key, state)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    voiceover = ASSETS_DIR / "voiceover.wav"

    emit("script", "running")
    _log("[1/5] script (LLM)...")
    result = script_stage.generate_script(topic)
    title, lines = result["title"], result["lines"]
    _log(f"      title={title!r}  lines={len(lines)}")
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
    clips = footage_stage.fetch_footage(lines, ASSETS_DIR)
    emit("footage", "done")

    emit("assemble", "running")
    _log("[5/5] assemble -> spec.json...")
    spec = assemble_stage.build_spec(title, offsets, words, clips, fps=fps)
    assemble_stage.write_spec(spec, SPEC_OUT)
    _log(f"      wrote {SPEC_OUT}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
    emit("assemble", "done")
    return spec


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
