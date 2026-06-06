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


def select_clip(videos, *, min_frames=0, fps):
    """Return (link, duration_frames) for the MOST RELEVANT usable clip: the first
    video in Pexels relevance order that has a usable portrait mp4.

    Duration no longer gates selection — a short clip loops over its span in
    `assemble`, so relevance is never traded away for length (the old min_frames
    bias actively dropped the top hit for a longer, less-relevant one). `min_frames`
    is kept for a future duration floor, deferred until the gate shows loops read.
    """
    for v in videos:
        link = pick_video_file(v.get("video_files", []))
        if link:
            return link, _video_duration_frames(v, fps)
    return None, None


def search_pexels(query: str, key: str) -> dict:
    r = requests.get(
        PEXELS_VIDEO_SEARCH,
        params={"query": query, "orientation": "portrait", "per_page": 15, "size": "medium"},
        headers={"Authorization": key},
        timeout=30,
    )
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
        downloader(url, dest)
        if duration_frames is not None:
            sidecar.write_text(str(duration_frames))

    return Clip(index=req.index, query=query, path=f"assets/{dest.name}", duration_frames=duration_frames)


def fetch_footage(requests_, out_dir, *, fps: int = 30, key=None, search=None, downloader=None) -> list[Clip]:
    key = key or require_env("PEXELS_API_KEY")
    search = search or search_pexels
    downloader = downloader or _download
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    clips: list[Clip] = []
    for req in requests_:
        query = req.query.strip()
        clip = _fetch_one(req, query, out_dir, fps=fps, key=key, search=search, downloader=downloader)
        if clip is None and req.broad_query:
            # The specific query whiffed (zero portrait clips). Broaden to the title
            # before failing the whole render — a loosely-relevant clip beats a crash.
            broad = req.broad_query.strip()
            if broad and broad.lower() != query.lower():
                clip = _fetch_one(req, broad, out_dir, fps=fps, key=key, search=search, downloader=downloader)
        if clip is None:
            raise RuntimeError(f"No Pexels portrait video for beat {req.index}: {req.query!r}")
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
