"""Stage 4 — fetch portrait stock clips from Pexels, one per footage beat.

Request-driven (step 6.4): the recipe plan decides which beats are `scene`-kind
and need footage; this stage fetches only those, keyed to their beat index.

Two robustness properties from the 6.4 review:
  * Clip DURATION comes from the Pexels response (`video.duration` seconds) —
    no ffprobe subprocess. A sidecar `.frames` file preserves it across the
    download cache so a cache hit still knows the length.
  * Selection BIAS: prefer a clip long enough to cover the scene span
    (`min_frames`), so the assemble loop-fallback rarely has to fire.

Caches downloads by query (filename = hash of query) so re-runs don't re-fetch.
Run standalone:  python backend/pipeline/footage.py --line "ocean waves" --out remotion/public/assets
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import hashlib
import os
import time
from pathlib import Path

import requests

from pipeline.config import require_env
from pipeline.contracts import Clip, FootageRequest

PEXELS_VIDEO_SEARCH = "https://api.pexels.com/videos/search"


def query_slug(query: str) -> str:
    return hashlib.sha1(query.strip().lower().encode("utf-8")).hexdigest()[:8]


def pick_video_file(video_files):
    """Pick the best portrait mp4: closest height to 1920, taller wins ties."""
    mp4 = [v for v in video_files if v.get("file_type") == "video/mp4"]
    portrait = [v for v in mp4 if v.get("height", 0) >= v.get("width", 0)]
    pool = portrait or mp4
    if not pool:
        return None
    pool.sort(key=lambda v: (abs(v.get("height", 0) - 1920), -v.get("height", 0)))
    return pool[0].get("link")


def _video_duration_frames(video, fps):
    dur = video.get("duration")
    return round(dur * fps) if dur else None


def candidate_rows(videos, *, query, fps):
    """Ranked candidate metadata for the HITL footage pool: rank (Pexels order),
    query, duration_frames, thumb_url. Usable portrait clips only (same filter as
    select_clip's pick_video_file)."""
    rows = []
    for v in videos:
        link = pick_video_file(v.get("video_files", []))
        if not link:
            continue   # rank counts usable clips only (len(rows)+1), not Pexels position
        pics = v.get("video_pictures") or []
        thumb = pics[0].get("picture") if pics else None
        rows.append({"rank": len(rows) + 1, "query": query,
                     "duration_frames": _video_duration_frames(v, fps),
                     "thumb_url": thumb, "link": link})
    return rows


def select_clip(videos, *, min_frames=0, fps):
    """Return (link, duration_frames) for the most relevant usable clip, subject to a
    SOFT loop floor: walk Pexels relevance order and take the first usable portrait
    clip whose duration clears `min_frames`; if none clears it, fall back to the first
    usable clip regardless of length.

    `min_frames` is the loop FLOOR (half the scene span, set by the caller — K=2), not
    the full span: relevance still wins among clips long enough to loop ≤ ~2× over the
    beat. The floor only displaces a *pathologically* short top hit when a longer
    usable clip exists below it (the diagnostic's 1s radar clip that looped 5× while a
    relevant 17s clip sat at rank 2). A clip with unknown duration is treated as
    clearing the floor (we can't measure it, so don't penalize it). When nothing
    clears the floor the assemble loop seam still covers the short clip over the span.
    """
    first_usable = None
    for v in videos:
        link = pick_video_file(v.get("video_files", []))
        if not link:
            continue
        frames = _video_duration_frames(v, fps)
        if first_usable is None:
            first_usable = (link, frames)
        if frames is None or frames >= min_frames:
            return link, frames
    return first_usable if first_usable is not None else (None, None)


def search_pexels(query: str, key: str, *, _get=None, _sleep=None, max_retries: int = 3) -> dict:
    """Search Pexels for portrait clips. Bounded retry with exponential backoff on
    429/5xx (honoring a Retry-After header on 429 when present), then raise — the
    caller (fetch_footage) broadens to the title on the raised error. The retry cap
    is small and fixed (Phase-3 cost discipline); _get/_sleep are injectable for tests."""
    _get = _get or requests.get
    _sleep = _sleep or time.sleep
    for attempt in range(max_retries + 1):
        r = _get(
            PEXELS_VIDEO_SEARCH,
            params={"query": query, "orientation": "portrait", "per_page": 15, "size": "medium"},
            headers={"Authorization": key},
            timeout=30,
        )
        retryable = r.status_code == 429 or 500 <= r.status_code < 600
        if retryable and attempt < max_retries:
            retry_after = r.headers.get("Retry-After")
            try:
                delay = float(retry_after)
                if delay <= 0:
                    raise ValueError("non-positive Retry-After")
            except (TypeError, ValueError):
                delay = 2.0 ** attempt
            _sleep(delay)
            continue
        r.raise_for_status()
        return r.json()


def _download(url: str, dest: Path) -> None:
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)


def _read_sidecar(path: Path):
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def _fetch_one(req, query, out_dir, *, fps, key, search, downloader):
    """Cache-or-fetch one clip for `query`. Returns a Clip, or None when the search
    yields no usable portrait clip (so the caller can broaden). Caches by query
    slug; a sidecar `.frames` preserves the duration across the download cache."""
    slug = query_slug(query)
    dest = out_dir / f"footage_{slug}.mp4"
    sidecar = out_dir / f"footage_{slug}.frames"

    if dest.exists():
        duration_frames = _read_sidecar(sidecar)  # may be None if unknown
    else:
        data = search(query, key)
        url, duration_frames = select_clip(data.get("videos", []), min_frames=req.min_frames, fps=fps)
        if not url:
            return None
        # Atomic write: stream into a sibling .part, then os.replace onto dest only
        # on success. A truncated .part is unlinked and never becomes a cached dest.
        tmp = dest.parent / (dest.name + ".part")
        try:
            downloader(url, tmp)
            os.replace(tmp, dest)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        if duration_frames is not None:
            sidecar.write_text(str(duration_frames))  # only AFTER the rename

    return Clip(index=req.index, query=query, path=f"assets/{dest.name}", duration_frames=duration_frames)


def fetch_footage(requests_, out_dir, *, fps: int = 30, key=None, search=None, downloader=None) -> list[Clip]:
    key = key or require_env("PEXELS_API_KEY")
    search = search or search_pexels
    downloader = downloader or _download
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def attempt(req, query):
        """Fetch one clip, treating a Pexels/network ERROR the same as an empty result:
        return (clip_or_None, error_or_None) so the caller can broaden instead of letting
        a raw requests exception abort the whole render. An empty query is skipped (Pexels
        400s on it) so it falls straight through to the broaden fallback."""
        if not query:
            return None, None
        try:
            return _fetch_one(req, query, out_dir, fps=fps, key=key, search=search, downloader=downloader), None
        except requests.RequestException as e:
            return None, e

    clips: list[Clip] = []
    for req in requests_:
        query = req.query.strip()
        clip, err = attempt(req, query)
        if clip is None and req.broad_query:
            # The specific query whiffed (zero portrait clips) OR errored (a 400 on an odd
            # query, a 429 burst, a 5xx, a timeout). Broaden to the title before failing the
            # whole render — a loosely-relevant clip beats a crash, and the simpler title
            # query usually succeeds where a too-specific one trips a Pexels error.
            broad = req.broad_query.strip()
            if broad and broad.lower() != query.lower():
                clip, broad_err = attempt(req, broad)
                err = broad_err or err
        if clip is None:
            detail = f" ({err})" if err else ""
            raise RuntimeError(f"No Pexels portrait video for beat {req.index}: {req.query!r}{detail}")
        clips.append(clip)
    return clips


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--line", action="append", required=True, help="repeatable")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()
    reqs = [FootageRequest(index=i, query=q) for i, q in enumerate(args.line)]
    for c in fetch_footage(reqs, args.out, fps=args.fps):
        print(f"{c.index}: {c.path}  ({c.duration_frames} frames)  <- {c.query!r}")
