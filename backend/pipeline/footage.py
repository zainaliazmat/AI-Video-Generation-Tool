"""Stage 4 — fetch one portrait stock clip per script line from Pexels.

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
from pipeline.contracts import Clip

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


def search_pexels(query: str, key: str) -> dict:
    r = requests.get(
        PEXELS_VIDEO_SEARCH,
        params={"query": query, "orientation": "portrait", "per_page": 5, "size": "medium"},
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


def fetch_footage(lines, out_dir, *, key=None, search=None, downloader=None) -> list[Clip]:
    key = key or require_env("PEXELS_API_KEY")
    search = search or search_pexels
    downloader = downloader or _download
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    clips: list[Clip] = []
    for i, line in enumerate(lines):
        query = line.strip()
        dest = out_dir / f"footage_{query_slug(query)}.mp4"
        if not dest.exists():
            data = search(query, key)
            videos = data.get("videos", [])
            url = pick_video_file(videos[0]["video_files"]) if videos else None
            if not url:
                raise RuntimeError(f"No Pexels portrait video for line {i}: {query!r}")
            downloader(url, dest)
        clips.append(Clip(index=i, query=query, path=f"assets/{dest.name}"))
    return clips


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--line", action="append", required=True, help="repeatable")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    for c in fetch_footage(args.line, args.out):
        print(f"{c.index}: {c.path}  <- {c.query!r}")
