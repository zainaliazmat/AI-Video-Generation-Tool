"""Enumeration layout motion-gate driver.

Produces REAL gate artifacts for one enumeration beat:
  1. Kokoro TTS  -> remotion/public/assets/<name>.wav        (genuine audio)
  2. faster-whisper -> real word timings                      (NOT estimated)
  3. a minimal one-scene `enumeration` spec -> public/spec.json + root/spec.json
  4. a Remotion MP4 render of the beat + a dense frame strip (ffmpeg)
  5. a markdown onset table: item -> spoken-word onset (ground truth) vs the
     resolved reveal frame (Python mirror of remotion/src/item-timing.ts)

Modes:
  sync       — items list matches the narration order; the resolver reconciles and
               each item reveals as its label is spoken (voice-locked).
  failclosed — items list is OUT OF ORDER vs the narration, so the resolver returns
               null and the component MUST degrade to the even-staggered entrance.

Usage:
  backend/.venv/bin/python backend/scripts/enumeration_gate.py --mode sync
  backend/.venv/bin/python backend/scripts/enumeration_gate.py --mode failclosed
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/

from pipeline import tts as tts_stage  # noqa: E402
from pipeline import timing as timing_stage  # noqa: E402

FPS = 30
ROOT = Path(__file__).resolve().parents[2]
REMOTION = ROOT / "remotion"
PUBLIC = REMOTION / "public"
ASSETS = PUBLIC / "assets"
GATE_OUT = ROOT / "enumeration-gate-frames"

# The canonical beat (also the Antikythera video's tarot-miss beat): names the five
# items in order so the resolver can voice-lock each reveal.
DEFAULT_LINE = "The bronze gears traced the sun, the moon, the planets, an eclipse, and lunar phases."
SYNC_ITEMS = ["Sun", "Moon", "Planets", "Eclipse", "Phases"]
# Out-of-order vs the narration (planets before moon) → realistic fail-closed.
FAILCLOSED_ITEMS = ["Sun", "Planets", "Moon", "Eclipse", "Phases"]
# Six items, named in order — proves the auto-fit layout shrinks (not wraps) at 6.
SIXITEM_LINE = "The orrery traced the sun, the moon, the planets, an eclipse, a comet, and lunar phases."
SIXITEM_ITEMS = ["Sun", "Moon", "Planets", "Eclipse", "Comet", "Phases"]


# ── Python mirror of remotion/src/item-timing.ts (for the ground-truth table) ──
_NON_ALNUM = re.compile(r"[^a-z0-9]")
_MIN_PREFIX = 4


def _norm(s: str) -> str:
    return _NON_ALNUM.sub("", unicodedata.normalize("NFKD", s).lower())


def _tok_match(lt: str, ct: str) -> bool:
    if not lt or not ct:
        return False
    if lt == ct:
        return True
    if len(lt) >= _MIN_PREFIX and len(ct) >= _MIN_PREFIX:
        return ct.startswith(lt) or lt.startswith(ct)
    return False


def _find_seq(caps, frm, toks) -> int:
    for k in range(frm, len(caps) - len(toks) + 1):
        if all(_tok_match(toks[t], caps[k + t][0]) for t in range(len(toks))):
            return k
    return -1


def item_onsets(labels, words):
    """[(label, onset_frame)] mirroring the TS resolver, or None (fail-closed)."""
    caps = [(_norm(w.text), w.start_frame) for w in words]
    out, ci = [], 0
    for label in labels:
        toks = [t for t in (_norm(p) for p in label.split()) if t]
        if not toks:
            return None
        at = _find_seq(caps, ci, toks)
        if at < 0:
            return None
        out.append((label, caps[at][1]))
        ci = at + len(toks)
    return out


# ── entrance amplitude (Python mirror of reveal.ts itemRevealState scale) ──────
# The amplitude readout reports the DESIGNED overshoot the component renders (both
# derive from scale = 0.8 + 0.2*easeOutBack(t)); the MP4 is the ground truth for
# feel. Per the cycle-amplitude principle: report peak-to-settle swing, not a
# per-frame delta.
def _ease_out_back(t: float) -> float:
    c = min(1.0, max(0.0, t))
    s = 1.70158
    p = c - 1
    return 1 + (s + 1) * p ** 3 + s * p ** 2


def entrance_amplitude(enter: int = 10) -> dict:
    scales = [0.8 + 0.2 * _ease_out_back(i / enter) for i in range(0, enter + 6)]
    peak = max(scales)
    return {"peak": peak, "settle": 0.8 + 0.2 * _ease_out_back(1.0),
            "peak_at": scales.index(peak)}


def base_theme() -> dict:
    return json.loads((ROOT / "spec.json").read_text())["theme"]


def build(line: str, name: str, items) -> dict:
    ASSETS.mkdir(parents=True, exist_ok=True)
    wav = ASSETS / f"enum-gate-{name}.wav"
    tts_stage.synthesize([line], str(wav))
    words = timing_stage.transcribe_words(str(wav), FPS)
    total = max((w.end_frame for w in words), default=FPS) + 1
    captions = [
        {"text": w.text, "startFrame": w.start_frame, "endFrame": w.end_frame} for w in words
    ]
    spec = {
        "meta": {"title": f"enum-gate-{name}", "fps": FPS, "width": 1080, "height": 1920,
                 "durationInFrames": total},
        "theme": base_theme(),
        "audio": {"voiceover": f"assets/enum-gate-{name}.wav"},
        "captions": captions,
        "scenes": [{
            "id": "scene-0", "startFrame": 0, "durationInFrames": total,
            "template": "enumeration", "templateProps": {"items": items},
        }],
    }
    (PUBLIC / "spec.json").write_text(json.dumps(spec, indent=2))
    (ROOT / "spec.json").write_text(json.dumps(spec, indent=2))
    return {"words": words, "total": total}


def render_mp4(name: str) -> Path:
    GATE_OUT.mkdir(parents=True, exist_ok=True)
    subprocess.run(["npm", "run", "build-registry"], cwd=str(REMOTION), check=True)
    out = GATE_OUT / f"{name}.mp4"
    subprocess.run(["npx", "remotion", "render", "Video", str(out)], cwd=str(REMOTION), check=True)
    return out


def extract_strip(mp4: Path, name: str, frames: list[int]) -> list[Path]:
    """Pull specific frames out of the MP4 with ffmpeg (fast, vs per-frame stills)."""
    pngs = []
    for f in frames:
        png = GATE_OUT / f"{name}-f{f:04d}.png"
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(mp4), "-vf", f"select=eq(n\\,{f})", "-vframes", "1", str(png)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        pngs.append(png)
    return pngs


def write_table(name: str, mode: str, words, items, onsets, amp=None) -> None:
    lines = [f"# Enumeration motion gate — {name} ({mode})", ""]
    if amp is not None:
        lines += [
            "## Entrance amplitude (designed overshoot; peak-to-settle swing)", "",
            f"- scale: settle `{amp['settle']:.3f}` → peak `{amp['peak']:.3f}` "
            f"(**+{amp['peak'] - amp['settle']:.3f}** at f+{amp['peak_at']}), translateY 28→0px, rotate -2→0°",
            "- the MP4 is the ground truth for feel; this is the magnitude the component renders.",
            "",
        ]
    lines += ["## Item → reveal alignment", "",
             "| # | item | spoken-word onset frame | onset t(s) | resolver |",
             "|---|------|------------------------|------------|----------|"]
    if onsets is None:
        for i, label in enumerate(items):
            lines.append(f"| {i} | `{label}` | — | — | NULL (fail-closed → even-staggered) |")
    else:
        for i, (label, frame) in enumerate(onsets):
            lines.append(f"| {i} | `{label}` | {frame} | {frame / FPS:.3f} | voice-locked |")
    lines += ["", "## Caption stream (ground truth)", "",
              "| word | startFrame | endFrame | start(s) |",
              "|------|-----------|----------|----------|"]
    for w in words:
        lines.append(f"| `{w.text}` | {w.start_frame} | {w.end_frame} | {w.start_frame / FPS:.3f} |")
    md = GATE_OUT / f"{name}-{mode}-table.md"
    md.write_text("\n".join(lines) + "\n")
    print(f"[gate] wrote {md.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["sync", "failclosed", "sixitem"], default="sync")
    ap.add_argument("--line", default="")  # empty → the per-mode default line
    args = ap.parse_args()
    name = args.mode
    lines = {"sync": DEFAULT_LINE, "failclosed": DEFAULT_LINE, "sixitem": SIXITEM_LINE}
    items_by_mode = {"sync": SYNC_ITEMS, "failclosed": FAILCLOSED_ITEMS, "sixitem": SIXITEM_ITEMS}
    line = args.line or lines[args.mode]
    items = items_by_mode[args.mode]

    built = build(line, name, items)
    words, total = built["words"], built["total"]
    onsets = item_onsets(items, words)
    amp = entrance_amplitude()
    print(f"[gate] items={items}")
    print(f"[gate] caption words ({len(words)}): {[w.text for w in words]}")
    print(f"[gate] resolved onsets: {onsets}")
    print(f"[gate] entrance scale: settle {amp['settle']:.3f} → peak {amp['peak']:.3f} "
          f"(+{amp['peak'] - amp['settle']:.3f} at f+{amp['peak_at']}), translateY 28→0px")

    mp4 = render_mp4(name)
    print(f"[gate] rendered {mp4.relative_to(ROOT)} ({total} frames)")

    # Strip: dense sweep across the reveal span + a frame just after each onset.
    sweep = list(range(2, total, max(1, total // 16)))
    onset_frames = [min(f + 4, total - 1) for _, f in (onsets or [])]
    frames = sorted(set(sweep + onset_frames + [total - 1]))
    extract_strip(mp4, name, frames)
    print(f"[gate] extracted {len(frames)} strip frames -> {GATE_OUT.relative_to(ROOT)}")

    write_table(name, args.mode, words, items, onsets, amp)


if __name__ == "__main__":
    main()
