"""A.2b — isolated file inspection for uploaded media.

Kept separate from footage.py so that stage's deliberate no-ffprobe stance stays
intact, and so the subprocess sits behind an injectable runner for offline unit
tests. Extension decides KIND (video vs image); ffprobe measures a video's
duration so a short upload loops to fill its scene span. Fail-loud throughout:
an unreadable duration is an error, never a silent 0/None.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def kind_from_extension(path) -> str:
    """'video' | 'image' from the file extension. ValueError on anything else."""
    ext = Path(path).suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    raise ValueError(
        f"unsupported upload extension {ext!r} for {path} "
        f"(video: {sorted(VIDEO_EXTS)}, image: {sorted(IMAGE_EXTS)})")


def slug(text) -> str:
    """Lowercase, hyphenated, filesystem-safe token for a filename component.
    Empty/symbol-only input degrades to 'upload' so the dest name is never blank."""
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return s or "upload"


def ffprobe_duration_seconds(path, *, run=None) -> float:
    """Duration in seconds via ffprobe. `run` is an injectable subprocess runner
    (defaults to subprocess.run) so tests need no real binary. Fail-loud
    (RuntimeError) on a missing binary, non-zero exit, or empty/unparseable/
    non-positive output — never returns None/0 silently."""
    run = run or subprocess.run
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    try:
        proc = run(cmd, capture_output=True, text=True)
    except FileNotFoundError as e:
        raise RuntimeError(f"ffprobe not available: {e}") from e
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed (exit {proc.returncode}) for {path}: {(proc.stderr or '').strip()}")
    raw = (proc.stdout or "").strip()
    try:
        dur = float(raw)
    except ValueError as e:
        raise RuntimeError(f"ffprobe returned unparseable duration {raw!r} for {path}") from e
    if dur <= 0:
        raise RuntimeError(f"ffprobe returned non-positive duration {dur} for {path}")
    return dur
