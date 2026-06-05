"""Faceless video generator — Phase 4 pipeline orchestrator.

Usage:  python backend/main.py --topic "3 facts about deep sea creatures"
Runs: script -> tts -> timing -> footage -> assemble, writing spec.json at the repo root.
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import argparse
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


def run(topic: str, fps: int = DEFAULT_FPS):
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    voiceover = ASSETS_DIR / "voiceover.wav"

    print("[1/5] script (LLM)...")
    result = script_stage.generate_script(topic)
    title, lines = result["title"], result["lines"]
    print(f"      title={title!r}  lines={len(lines)}")

    print("[2/5] tts (Kokoro)...")
    offsets = tts_stage.synthesize(lines, voiceover)

    print("[3/5] timing (faster-whisper)...")
    words = timing_stage.transcribe_words(str(voiceover), fps)
    print(f"      {len(words)} words timed")

    print("[4/5] footage (Pexels)...")
    clips = footage_stage.fetch_footage(lines, ASSETS_DIR)

    print("[5/5] assemble -> spec.json...")
    spec = assemble_stage.build_spec(title, offsets, words, clips, fps=fps)
    assemble_stage.write_spec(spec, SPEC_OUT)
    print(f"      wrote {SPEC_OUT}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
    return spec


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", required=True)
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS)
    args = ap.parse_args()
    run(args.topic, args.fps)
