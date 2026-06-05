"""Stage 3 — word-level caption timing from the generated voiceover (faster-whisper).

Times against the AUDIO, not the script text, so captions stay in sync.
Run standalone:  python backend/pipeline/timing.py --wav /tmp/vo.wav --fps 30
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

from pipeline.contracts import WordTiming
from pipeline.frames import seconds_to_frames


def words_to_timings(raw_words, fps) -> list[WordTiming]:
    out: list[WordTiming] = []
    for text, start, end in raw_words:
        t = text.strip()
        if not t:
            continue
        sf_ = seconds_to_frames(start, fps)
        ef = seconds_to_frames(end, fps)
        if ef <= sf_:
            ef = sf_ + 1
        out.append(WordTiming(text=t, start_frame=sf_, end_frame=ef))
    return out


def transcribe_words(wav_path, fps, *, model=None) -> list[WordTiming]:
    if model is None:
        from faster_whisper import WhisperModel
        model = WhisperModel("base", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav_path), word_timestamps=True, language="en")
    raw = []
    for seg in segments:
        for w in (seg.words or []):
            raw.append((w.word, w.start, w.end))
    return words_to_timings(raw, fps)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()
    for w in transcribe_words(args.wav, args.fps):
        print(f"[{w.start_frame}-{w.end_frame}] {w.text}")
