"""Hook word-sync gate driver.

Produces REAL gate artifacts for one hook line:
  1. Kokoro TTS  -> remotion/public/assets/<name>.wav   (genuine audio)
  2. faster-whisper -> real word timings                 (NOT estimated spans)
  3. a minimal one-scene spec (hook only) -> remotion/public/spec.json
  4. one Remotion still per word (frame = interval midpoint)
  5. a markdown table: frame | t(s) | expected-lit word | [start,end)

Modes:
  sync         — title matches the audio; the aligner should reconcile.
  failclosed   — captions are scrambled so the aligner returns null; the render
                 must degrade to the Round-1 entrance (no per-word accent).
  realpipeline — use the REAL multi-scene spec.json (from a full backend/main.py
                 run) as-is, slicing captions to the hook span. Reproduces the
                 production path: full-VO whisper fragmentation + next-beat bleed.

Usage:
  backend/.venv/bin/python backend/scripts/hook_gate.py \
      --line "Why is the ocean blue?" --name short --mode sync
  backend/.venv/bin/python backend/scripts/hook_gate.py --mode realpipeline
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import namedtuple
from pathlib import Path

# Run from anywhere: put backend/ on the path so `pipeline` resolves regardless
# of cwd (the script lives in backend/scripts/, so backend/ is its parent's dir).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pipeline import tts as tts_stage  # noqa: E402
from pipeline import timing as timing_stage  # noqa: E402

# A caption slice row with the same attrs render_stills/write_table expect from a
# WordTiming (.text/.start_frame/.end_frame), so both modes share that code.
Cap = namedtuple("Cap", "text start_frame end_frame")

FPS = 30
ROOT = Path(__file__).resolve().parents[2]
REMOTION = ROOT / "remotion"
PUBLIC = REMOTION / "public"
ASSETS = PUBLIC / "assets"
GATE_OUT = ROOT / "hook-gate-frames"


def base_theme() -> dict:
    """Lift a valid theme from the committed spec.json (no new theme authored)."""
    spec = json.loads((ROOT / "spec.json").read_text())
    return spec["theme"]


def build(line: str, name: str, mode: str) -> dict:
    ASSETS.mkdir(parents=True, exist_ok=True)
    wav = ASSETS / f"hook-gate-{name}.wav"
    tts_stage.synthesize([line], str(wav))
    words = timing_stage.transcribe_words(str(wav), FPS)
    total = max((w.end_frame for w in words), default=FPS) + 1

    captions = [
        {"text": w.text, "startFrame": w.start_frame, "endFrame": w.end_frame}
        for w in words
    ]
    if mode == "failclosed":
        # Scramble caption TEXT (keep timing) so char-prefix reconciliation fails
        # -> aligner returns null -> component must use the Round-1 entrance.
        for c in captions:
            c["text"] = "zzz"

    spec = {
        "meta": {
            "title": f"hook-gate-{name}",
            "fps": FPS,
            "width": 1080,
            "height": 1920,
            "durationInFrames": total,
        },
        "theme": base_theme(),
        "audio": {"voiceover": f"assets/hook-gate-{name}.wav"},
        "captions": captions,
        "scenes": [
            {
                "id": "scene-0",
                "startFrame": 0,
                "durationInFrames": total,
                "template": "hook",
                "templateProps": {"title": line, "subtitle": "WORD-SYNC GATE"},
            }
        ],
    }
    (PUBLIC / "spec.json").write_text(json.dumps(spec, indent=2))
    (ROOT / "spec.json").write_text(json.dumps(spec, indent=2))
    return {"words": words, "total": total}


def build_realpipeline() -> dict:
    """Use the REAL multi-scene spec.json (from a full `backend/main.py` run) as-is.
    Slices the captions to the hook scene's span — reproducing the production path
    the bug was found in: full-VO whisper fragmentation + a next-beat word bleeding
    into the tail of the hook span. No synth/transcribe here; the spec is real."""
    spec = json.loads((ROOT / "spec.json").read_text())
    hook = spec["scenes"][0]
    assert hook["template"] == "hook", "scene 0 must be the hook"
    start = hook["startFrame"]
    end = start + hook["durationInFrames"]
    span = sorted(
        (
            Cap(c["text"], c["startFrame"], c["endFrame"])
            for c in spec["captions"]
            if c["startFrame"] < end and c["endFrame"] > start
        ),
        key=lambda c: c.start_frame,
    )
    # Stage the real spec for the renderer + report the slice for the eyeball pass.
    subprocess.run(["npm", "run", "copy-spec"], cwd=str(REMOTION), check=True)
    print(f"[gate] hook title : {hook['templateProps'].get('title')!r}")
    print(f"[gate] hook span  : [{start}, {end})")
    print(f"[gate] caption slice ({len(span)}): {[c.text for c in span]}")
    return {"words": span, "total": end}


def lit_word_at(frame: int, words):
    """The word whose half-open [start,end) interval contains `frame` — the gate's
    'expected lit word' — or None if the frame is in a gap (no word spoken)."""
    for w in words:
        if w.start_frame <= frame < w.end_frame:
            return w
    return None


def render_stills(name: str, words, scene_end: int) -> list[dict]:
    GATE_OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    # An early frame (frame 2) plus one frame per word at its interval midpoint,
    # CLAMPED into the hook scene span [0, scene_end). A next-beat caption can
    # straddle the boundary (e.g. an "It"-bleed whose midpoint lands in the next
    # scene); clamping keeps the still inside the hook so the bleed reads as
    # "ignored" (no accent) rather than rendering a different scene.
    # The expected-lit word for EVERY frame is derived from interval membership,
    # not assumed — so a frame-0-starting first word correctly reads as lit.
    sample_frames = [2] + [
        min((w.start_frame + w.end_frame) // 2, scene_end - 1) for w in words
    ]
    for frame in sample_frames:
        png = GATE_OUT / f"{name}-f{frame:04d}.png"
        subprocess.run(
            ["npx", "remotion", "still", "Video", str(png), f"--frame={frame}"],
            cwd=str(REMOTION),
            check=True,
        )
        lit = lit_word_at(frame, words)
        rows.append(
            {
                "frame": frame,
                "t_seconds": round(frame / FPS, 3),
                "expected_lit": (lit.text if lit else "(none — gap, no word)"),
                "interval": ([lit.start_frame, lit.end_frame] if lit else None),
                "png": str(png.relative_to(ROOT)),
            }
        )
    return rows


def write_table(name: str, mode: str, words, rows) -> None:
    lines = [
        f"# Hook word-sync gate — {name} ({mode})",
        "",
        "## Word-timing table (ground truth)",
        "",
        "| # | word | startFrame | endFrame | start(s) | end(s) |",
        "|---|------|-----------|----------|----------|--------|",
    ]
    for i, w in enumerate(words):
        lines.append(
            f"| {i} | `{w.text}` | {w.start_frame} | {w.end_frame} | "
            f"{w.start_frame / FPS:.3f} | {w.end_frame / FPS:.3f} |"
        )
    lines += ["", "## Rendered frames", "",
              "| frame | t(s) | expected lit word | interval | png |",
              "|-------|------|-------------------|----------|-----|"]
    for r in rows:
        lines.append(
            f"| {r['frame']} | {r['t_seconds']} | {r['expected_lit']} | "
            f"{r['interval']} | {r['png']} |"
        )
    md = GATE_OUT / f"{name}-{mode}-table.md"
    md.write_text("\n".join(lines) + "\n")
    print(f"[gate] wrote {md.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--line", default="")
    ap.add_argument("--name", default="realpipeline")
    ap.add_argument(
        "--mode", choices=["sync", "failclosed", "realpipeline"], default="sync"
    )
    args = ap.parse_args()

    if args.mode == "realpipeline":
        built = build_realpipeline()
    else:
        assert args.line, "--line is required for sync / failclosed modes"
        built = build(args.line, args.name, args.mode)
    rows = render_stills(args.name, built["words"], built["total"])
    write_table(args.name, args.mode, built["words"], rows)


if __name__ == "__main__":
    main()
