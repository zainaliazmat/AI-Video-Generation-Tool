"""Stage 3 — word-level caption timing from the generated voiceover (faster-whisper).

Times against the AUDIO, not the script text, so captions stay in sync.
Run standalone:  python backend/pipeline/timing.py --wav /tmp/vo.wav --fps 30
"""
from __future__ import annotations

import re
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

from pipeline.contracts import WordTiming
from pipeline.frames import seconds_to_frames

# A token that continues a number split off by faster-whisper: a separator
# followed by a digit (",700", ".5"). Glued onto the preceding digit-ending word.
_NUM_FRAG = re.compile(r"^[.,]\d")


def _continues_number(prev_text: str, frag: str) -> bool:
    """True when `frag` is the tail of a number whose head is `prev_text` — so the
    two are one number whisper split (e.g. "37" + ",700", or "37," + "700"). Narrow
    by design: only fires across a separator boundary, never between plain words."""
    if not prev_text:
        return False
    last = prev_text[-1]
    if _NUM_FRAG.match(frag) and last.isdigit():
        return True                       # "37" + ",700"
    if last in ".," and frag[:1].isdigit():
        return True                       # "37," + "700"
    return False


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
        # Number-atomic: re-glue a numeric tail onto the accumulating word so the
        # karaoke never shows a leading-comma fragment like ",700". Chains across
        # multiple separators ("1" + ",234" + ",567" -> "1,234,567").
        if out and _continues_number(out[-1].text, t):
            out[-1].text += t
            out[-1].end_frame = ef
            continue
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
