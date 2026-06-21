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
import json
import os
import time
from collections import namedtuple
from pathlib import Path

import requests

from pipeline.config import require_env
from pipeline.contracts import Clip, FootageRequest

# select_clip's surfaced choice: link/duration as before, plus the chosen clip's
# usable-rank (1-based among USABLE clips, matching candidate_rows) and Pexels origin.
Selection = namedtuple("Selection", "link duration_frames rank pexels_id pexels_url")

PEXELS_VIDEO_SEARCH = "https://api.pexels.com/videos/search"
PEXELS_PHOTO_SEARCH = "https://api.pexels.com/v1/search"

# v3-M5 T2 (OV-5): hero scene background auto-fill policy.
# "auto"     → pick rank-1 from the scene's pool (with K-floor) and download it.
# "gradient" → pool stays fetched for the gate UI; NO override row, NO download.
# Policy-as-data lives here, next to select_clip and fetch_pool (its mechanism),
# NOT in main.py (which imports torch-heavy pipeline.tts at module level).
HERO_BACKGROUND_POLICY: dict[str, str] = {
    "hook": "auto",
    "outro": "auto",
    "stat": "gradient",
}


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
                     "thumb_url": thumb, "link": link,
                     "pexels_id": v.get("id"), "pexels_url": v.get("url")})
    return rows


def select_clip(videos, *, min_frames=0, fps):
    """Return a Selection for the most relevant usable clip, subject to a SOFT loop
    floor (see FootageRequest). Surfaces the chosen clip's usable-rank (1-based among
    usable portrait clips — the same metric candidate_rows reports) and Pexels id/url
    so provenance is captured from the real choice, never link-matched.
    """
    first_usable = None
    usable_rank = 0
    for v in videos:
        link = pick_video_file(v.get("video_files", []))
        if not link:
            continue
        usable_rank += 1
        frames = _video_duration_frames(v, fps)
        sel = Selection(link, frames, usable_rank, v.get("id"), v.get("url"))
        if first_usable is None:
            first_usable = sel
        if frames is None or frames >= min_frames:
            return sel
    return first_usable if first_usable is not None else Selection(None, None, None, None, None)


def _pexels_search(url, params, key, *, _get=None, _sleep=None, max_retries: int = 3) -> dict:
    """Shared Pexels GET with bounded retry + exponential backoff on 429/5xx (honoring a
    Retry-After header on 429 when present), then raise. The retry cap is small and fixed
    (Phase-3 cost discipline); _get/_sleep are injectable for tests. Both the video and
    photo searchers route through here so the backoff logic lives in exactly one place."""
    _get = _get or requests.get
    _sleep = _sleep or time.sleep
    for attempt in range(max_retries + 1):
        r = _get(url, params=params, headers={"Authorization": key}, timeout=30)
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


def search_pexels(query: str, key: str, *, orientation: str | None = "portrait",
                  _get=None, _sleep=None, max_retries: int = 3) -> dict:
    """Search Pexels videos. `orientation` filters the result set; pass None to drop the
    filter so Pexels returns its true relevance ranking across ALL orientations (the
    footage-source-overhaul measurement passes None; production default stays "portrait"
    until measurement validates the switch). On 429/5xx exhaustion this raises and the
    caller (fetch_footage) broadens to the title."""
    params = {"query": query, "per_page": 15, "size": "medium"}
    if orientation is not None:
        params["orientation"] = orientation
    return _pexels_search(PEXELS_VIDEO_SEARCH, params, key,
                          _get=_get, _sleep=_sleep, max_retries=max_retries)


def search_pexels_photos(query: str, key: str, *, orientation: str | None = None,
                         _get=None, _sleep=None, max_retries: int = 3) -> dict:
    """Search Pexels photos (the alternate source for niche beats where video relevance is
    thin). Default orientation is unfiltered: photos are high-res enough that a vertical
    cover-crop never upscales, so we keep the full relevance ranking. Shares the retry
    backoff with search_pexels (F3)."""
    params = {"query": query, "per_page": 15}
    if orientation is not None:
        params["orientation"] = orientation
    return _pexels_search(PEXELS_PHOTO_SEARCH, params, key,
                          _get=_get, _sleep=_sleep, max_retries=max_retries)


def pick_photo(photo: dict):
    """Best downloadable src for a Pexels photo. Prefer the widest sizes (large2x ~1880w,
    then original) so a 1080×1920 cover-crop stays crisp; never the small/medium/tiny
    thumbs (they would upscale). Returns None when the photo carries no usable src."""
    src = photo.get("src") or {}
    for key in ("large2x", "original"):
        if src.get(key):
            return src[key]
    return None


def fetch_pool(
    query: str,
    key: str,
    fps: int,
    *,
    cache_dir=None,
    search=None,
) -> dict:
    """Fetch (or return cached) the ranked candidate pool for `query`.

    Returns a dict with:
      - "rows":  list[dict] from candidate_rows — empty on any error
      - "error": None | "rate_limited" | "fetch_error" — structured error state
        (OV-6 honesty contract: exhaustion records pool=[] + error marker instead
        of crashing; the M6 strip copy is "pool fetch hit the rate limit — retry
        in N min").

    Cache layout: `cache_dir / footage_pools / pool_{sha1(hardened_query)[:16]}.json`
    Mirrors the retrieval Tavily cache keying (sha1, 16 hex chars, json file).
    A repeated hardened query costs ZERO network calls (same idiom, different dir).
    """
    search = search or search_pexels

    cache_path = None
    if cache_dir is not None:
        pool_cache_dir = Path(cache_dir) / "footage_pools"
        pool_cache_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha1(query.strip().lower().encode("utf-8")).hexdigest()[:16]
        cache_path = pool_cache_dir / f"pool_{digest}.json"
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass  # corrupt cache file — fall through to re-fetch

    try:
        data = search(query, key)
        rows = candidate_rows(data.get("videos", []), query=query, fps=fps)
        result = {"rows": rows, "error": None}
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 429:
            result = {"rows": [], "error": "rate_limited"}
        else:
            result = {"rows": [], "error": "fetch_error"}
    except Exception:
        result = {"rows": [], "error": "fetch_error"}

    if cache_path is not None and result["error"] is None:
        # Only cache successful fetches — a transient error must not freeze an empty pool.
        try:
            cache_path.write_text(json.dumps(result), encoding="utf-8")
        except OSError:
            pass  # write failure is non-fatal; next run re-fetches

    return result


def photo_candidate_rows(photos, *, query):
    """Ranked candidate rows for a Pexels PHOTO search, shaped like candidate_rows so the
    gate pool can mix photos and videos. kind="image", duration_frames=None (stills don't
    loop), link = the high-res src pick_photo would download. Usable photos only (a photo
    with no large2x/original src is skipped, so rank counts usable photos)."""
    rows = []
    for p in photos:
        link = pick_photo(p)
        if not link:
            continue
        src = p.get("src") or {}
        rows.append({"rank": len(rows) + 1, "query": query, "duration_frames": None,
                     "thumb_url": src.get("medium") or src.get("tiny"), "link": link,
                     "pexels_id": p.get("id"), "pexels_url": p.get("url"), "kind": "image"})
    return rows


def _tag_rows(rows, *, kind, source):
    for r in rows:
        r["kind"] = kind
        r["source"] = source
    return rows


def fetch_pool_merged(
    query: str,
    key: str,
    fps: int,
    *,
    cache_dir=None,
    per_source: int = 8,
    search=None,
    photo_search=None,
) -> dict:
    """The gate's candidate pool from THREE sources: portrait video (PRIMARY), unfiltered
    video, and photos. The 2026-06-14 measurement showed no single source wins every topic
    (portrait nails octopuses, photos nail antikythera, unfiltered helps niche), and the
    worst niche failures are "on-word, wrong-sense" that no auto-trigger catches — so we
    WIDEN the pool and let the human pick at the gate instead of auto-picking.

    Each row is tagged: kind ∈ {"video","image"}, source ∈ {"portrait","unfiltered","photo"}.
    Unfiltered rows that duplicate a portrait clip (same pexels_id OR link) are dropped.
    The merged list is renumbered to ONE contiguous `rank` because the footage_candidates
    PK and the gate pick op both address rows by rank.

    Error policy (OV-6 honesty): only a PRIMARY (portrait) failure sets `error`; unfiltered
    and photo are best-effort extras that degrade silently to fewer candidates. Caches the
    merged blob under sha1(query) in `footage_pools_merged/` (distinct from fetch_pool's
    portrait-only cache so the two never collide)."""
    search = search or search_pexels
    photo_search = photo_search or search_pexels_photos

    cache_path = None
    if cache_dir is not None:
        pool_dir = Path(cache_dir) / "footage_pools_merged"
        pool_dir.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha1(query.strip().lower().encode("utf-8")).hexdigest()[:16]
        cache_path = pool_dir / f"pool_{digest}.json"
        if cache_path.exists():
            try:
                return json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass  # corrupt cache — re-fetch

    # PRIMARY: portrait video. Its failure is the contract error (mirrors fetch_pool).
    # Called WITHOUT an explicit orientation so it rides search_pexels' "portrait" default
    # (and stays compatible with the (query, key) search seam the gate tests inject).
    try:
        videos = search(query, key).get("videos", [])
        portrait = _tag_rows(candidate_rows(videos, query=query, fps=fps)[:per_source],
                             kind="video", source="portrait")
        error = None
    except requests.HTTPError as exc:
        portrait = []
        error = ("rate_limited" if (exc.response is not None
                                    and exc.response.status_code == 429) else "fetch_error")
    except Exception:
        portrait = []
        error = "fetch_error"

    seen_ids = {r["pexels_id"] for r in portrait if r.get("pexels_id") is not None}
    seen_links = {r.get("link") for r in portrait}

    # EXTRA 1: unfiltered video (best-effort) — drop clips already shown as portrait.
    unfiltered = []
    try:
        uf = search(query, key, orientation=None).get("videos", [])
        for r in candidate_rows(uf, query=query, fps=fps):
            if r.get("pexels_id") in seen_ids or r.get("link") in seen_links:
                continue
            unfiltered.append(r)
            if len(unfiltered) >= per_source:
                break
        _tag_rows(unfiltered, kind="video", source="unfiltered")
    except Exception:
        unfiltered = []

    # EXTRA 2: photos (best-effort) — the niche-beat alternate source.
    photos = []
    try:
        ph = photo_search(query, key).get("photos", [])
        photos = _tag_rows(photo_candidate_rows(ph, query=query)[:per_source],
                           kind="image", source="photo")
    except Exception:
        photos = []

    merged = portrait + unfiltered + photos
    for i, r in enumerate(merged, 1):
        r["rank"] = i  # single contiguous rank space (PK + pick addressing)

    result = {"rows": merged, "error": error}
    if cache_path is not None and error is None:
        try:
            cache_path.write_text(json.dumps(result), encoding="utf-8")
        except OSError:
            pass
    return result


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


def _write_prov_sidecar(path: Path, rank, pexels_id, pexels_url) -> None:
    path.write_text(json.dumps({"rank": rank, "pexels_id": pexels_id, "pexels_url": pexels_url}))


def _read_prov_sidecar(path: Path):
    """(rank, pexels_id, pexels_url) from the sidecar, or (None, None, None) when it is
    absent/corrupt — mirrors _read_sidecar's tolerant posture for legacy cached clips."""
    try:
        d = json.loads(path.read_text())
        return d.get("rank"), d.get("pexels_id"), d.get("pexels_url")
    except (OSError, ValueError):
        return None, None, None


def _fetch_one(req, query, out_dir, *, fps, key, search, downloader):
    """Cache-or-fetch one clip for `query`. Returns a Clip, or None when the search
    yields no usable portrait clip (so the caller can broaden). Caches by query slug;
    a `.frames` sidecar preserves the duration and a `.prov.json` sidecar preserves the
    A.2a provenance (rank + Pexels id/url) across the download cache."""
    slug = query_slug(query)
    dest = out_dir / f"footage_{slug}.mp4"
    sidecar = out_dir / f"footage_{slug}.frames"
    prov_sidecar = out_dir / f"footage_{slug}.prov.json"

    if dest.exists():
        duration_frames = _read_sidecar(sidecar)  # may be None if unknown
        rank, pexels_id, pexels_url = _read_prov_sidecar(prov_sidecar)  # None,None,None if legacy
    else:
        data = search(query, key)
        sel = select_clip(data.get("videos", []), min_frames=req.min_frames, fps=fps)
        url, duration_frames = sel.link, sel.duration_frames
        rank, pexels_id, pexels_url = sel.rank, sel.pexels_id, sel.pexels_url
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
        _write_prov_sidecar(prov_sidecar, rank, pexels_id, pexels_url)  # only AFTER the rename

    return Clip(index=req.index, query=query, path=f"assets/{dest.name}",
                duration_frames=duration_frames, rank=rank,
                pexels_id=pexels_id, pexels_url=pexels_url)


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
