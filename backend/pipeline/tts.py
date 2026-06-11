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

DEFAULT_VOICE = "af_heart"

# Curated Kokoro voices (all free, all local — there is NO paid tier, per PRD §6.2).
# id = Kokoro voice key; lang_code drives the KPipeline (a=American, b=British).
VOICES = [
    {"id": "af_heart",    "name": "Heart",    "character": "Warm, default narrator",   "lang": "a"},
    {"id": "af_bella",    "name": "Bella",    "character": "Bright, energetic",         "lang": "a"},
    {"id": "af_nicole",   "name": "Nicole",   "character": "Soft, intimate",            "lang": "a"},
    {"id": "af_sarah",    "name": "Sarah",    "character": "Clear, neutral",            "lang": "a"},
    {"id": "af_sky",      "name": "Sky",      "character": "Light, youthful",           "lang": "a"},
    {"id": "am_adam",     "name": "Adam",     "character": "Deep, steady male",         "lang": "a"},
    {"id": "am_michael",  "name": "Michael",  "character": "Confident male",            "lang": "a"},
    {"id": "bf_emma",     "name": "Emma",     "character": "British, composed",         "lang": "b"},
    {"id": "bf_isabella", "name": "Isabella", "character": "British, expressive",       "lang": "b"},
    {"id": "bm_george",   "name": "George",   "character": "British, authoritative",    "lang": "b"},
]
_VOICE_IDS = {v["id"] for v in VOICES}
_LANG_BY_ID = {v["id"]: v["lang"] for v in VOICES}


def lang_for_voice(voice: str) -> str:
    """American 'a' / British 'b' KPipeline lang_code for a voice id (default 'a')."""
    return _LANG_BY_ID.get(voice, "a")


def is_valid_voice(voice: str) -> bool:
    return voice in _VOICE_IDS


def compute_offsets(lines, durations, *, gap=SILENCE_SEC) -> list[LineOffset]:
    offsets: list[LineOffset] = []
    cursor = 0.0
    for i, (text, dur) in enumerate(zip(lines, durations)):
        start = cursor
        end = start + dur
        offsets.append(LineOffset(index=i, text=text, start=start, end=end))
        cursor = end + gap
    return offsets


def _kokoro_synth(line: str, pipeline, *, voice=DEFAULT_VOICE, speed=1) -> np.ndarray:
    chunks = []
    for _, _, audio in pipeline(line, voice=voice, speed=speed):
        chunks.append(np.asarray(audio, dtype=np.float32))
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def synthesize(lines, out_path, *, synth=None, pipeline=None,
               voice=DEFAULT_VOICE, speed=1) -> list[LineOffset]:
    """Synthesize a continuous voiceover. `voice` selects the Kokoro voice (PRD §6.2
    Voice gate); `speed` is the 0.8x-1.2x rate. `synth`/`pipeline` are injectable so
    tests run offline. A new voice/speed picks the matching lang_code pipeline."""
    if synth is None:
        if pipeline is None:
            from kokoro import KPipeline
            pipeline = KPipeline(lang_code=lang_for_voice(voice))
        synth = lambda line: _kokoro_synth(line, pipeline, voice=voice, speed=speed)

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
