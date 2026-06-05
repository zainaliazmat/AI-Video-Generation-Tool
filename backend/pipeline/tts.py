"""Stage 2 — synthesize the voiceover with Kokoro (voice af_heart, 24 kHz).

Writes one continuous wav and returns per-line second offsets for scene timing.
Run standalone:  python backend/pipeline/tts.py --line "Hello world" --out /tmp/vo.wav
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline.contracts import LineOffset

SAMPLE_RATE = 24000
SILENCE_SEC = 0.15  # gap inserted between lines


def compute_offsets(lines, durations, *, gap=SILENCE_SEC) -> list[LineOffset]:
    offsets: list[LineOffset] = []
    cursor = 0.0
    for i, (text, dur) in enumerate(zip(lines, durations)):
        start = cursor
        end = start + dur
        offsets.append(LineOffset(index=i, text=text, start=start, end=end))
        cursor = end + gap
    return offsets


def _kokoro_synth(line: str, pipeline) -> np.ndarray:
    chunks = []
    for _, _, audio in pipeline(line, voice="af_heart", speed=1):
        chunks.append(np.asarray(audio, dtype=np.float32))
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def synthesize(lines, out_path, *, synth=None, pipeline=None) -> list[LineOffset]:
    if synth is None:
        if pipeline is None:
            from kokoro import KPipeline
            pipeline = KPipeline(lang_code="a")
        synth = lambda line: _kokoro_synth(line, pipeline)

    audios = [synth(line) for line in lines]
    durations = [len(a) / SAMPLE_RATE for a in audios]
    offsets = compute_offsets(lines, durations)

    gap = np.zeros(int(SILENCE_SEC * SAMPLE_RATE), dtype=np.float32)
    parts = []
    for i, a in enumerate(audios):
        parts.append(a)
        if i < len(audios) - 1:
            parts.append(gap)
    full = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), full, SAMPLE_RATE)
    return offsets


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--line", action="append", required=True, help="repeatable")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    offs = synthesize(args.line, args.out)
    for o in offs:
        print(f"[{o.start:.2f}-{o.end:.2f}] {o.text}")
