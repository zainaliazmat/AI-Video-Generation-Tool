"""Phase 4 — footage relevance DIAGNOSTIC (the gate instrument; not the pipeline).

A measurement tool. For each footage beat it shows the EXACT query sent + the full
ranked Pexels candidate list (rank, duration, usable?, which one select_clip picks,
thumbnail URL, page slug), the loop factor of the pick (playthroughs to fill the
span -> the relevance-vs-duration band question), and downloads the top-N thumbnails
so the RELEVANCE read is eyes-on, not slug-guessed.

Modes:
  --topic "the deep ocean"   full pipeline: grounded script -> recipe -> per-beat
                             queries (+ broad fallback). Needs DEEPSEEK+TAVILY+PEXELS.
                             Span is ESTIMATED from word count (no TTS run here).
  --query "ocean trench"     Pexels-only, repeatable: skips the LLM. Needs only PEXELS.

Run:
  python backend/pipeline/footage_diagnostic.py --topic "the deep ocean" --thumbs /tmp/diag
  python backend/pipeline/footage_diagnostic.py --query "ocean trench" --thumbs /tmp/diag
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # backend/

import math
from pathlib import Path

from pipeline.footage import pick_video_file, _video_duration_frames, search_pexels


def summarize_candidates(videos, *, fps):
    """Rank-ordered view of a Pexels search result. `selected` marks the FIRST
    usable portrait clip — exactly what select_clip now picks (relevance-first)."""
    rows = []
    picked = False
    for rank, v in enumerate(videos, 1):
        link = pick_video_file(v.get("video_files", []))
        usable = link is not None
        selected = usable and not picked
        if selected:
            picked = True
        rows.append({
            "rank": rank,
            "duration_s": v.get("duration"),
            "duration_frames": _video_duration_frames(v, fps),
            "usable": usable,
            "selected": selected,
            "thumb": v.get("image"),
            "page": v.get("url"),
        })
    return rows


def loop_playthroughs(span_frames, clip_frames):
    """How many times the picked clip plays to fill the scene span (ceil). 1 = no
    loop; >=2 = perceptible repeat (the K-floor trigger). None when unknown."""
    if not clip_frames or clip_frames <= 0:
        return None
    return math.ceil(span_frames / clip_frames)


# ── instrumentation (I/O; the pure cores above are unit-tested) ─────────────

def _download_thumb(url, dest):
    import requests
    try:
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return True
    except Exception as e:  # diagnostic — a failed thumbnail must not abort the run
        print(f"      (thumb download failed: {e})", file=sys.stderr)
        return False


def _report(label, query, videos, *, fps, span_frames=None, broad_query=None,
            thumbs_dir=None, top_n=8, tag="q"):
    rows = summarize_candidates(videos, fps=fps)
    hdr = f"\n=== {label}: query={query!r}"
    if broad_query:
        hdr += f"   (broad fallback={broad_query!r})"
    print(hdr + " ===")
    if not rows:
        print("  (no candidates returned)")
        return rows
    print("  rank  dur(s)  frames  usable  sel  thumbnail")
    for r in rows:
        print(f"  {r['rank']:>3}   {str(r['duration_s']):>5}  {str(r['duration_frames']):>6}  "
              f"{('yes' if r['usable'] else 'no'):>6}  {('*' if r['selected'] else ''):>3}  {r['thumb']}")
    sel = next((r for r in rows if r["selected"]), None)
    if sel and span_frames:
        pt = loop_playthroughs(span_frames, sel["duration_frames"])
        loops = "  (LOOPS)" if pt and pt >= 2 else ""
        print(f"  -> pick rank {sel['rank']}: {sel['duration_frames']}f vs span ~{span_frames}f"
              f"  => {pt} playthrough(s){loops}")
    if thumbs_dir:
        d = Path(thumbs_dir); d.mkdir(parents=True, exist_ok=True)
        for r in rows[:top_n]:
            if r["thumb"]:
                dest = d / f"{tag}_rank{r['rank']:02d}{'_SEL' if r['selected'] else ''}.jpg"
                _download_thumb(r["thumb"], dest)
        print(f"  thumbnails -> {d}/{tag}_rank*.jpg")
    return rows


def _run_topic(topic, *, fps, thumbs_dir, top_n, key):
    from pipeline import script as script_stage, recipe as recipe_stage
    from schema import Theme
    repo = Path(__file__).resolve().parents[2]
    cache = repo / ".cache" / "retrieval"
    print(f"\n########## TOPIC: {topic!r} ##########")
    script = script_stage.generate_grounded_script(topic, cache_dir=cache)
    plan = recipe_stage.plan(script, theme=Theme())
    print(f"title={script.title!r}  beats={len(script.beats)}  roles={[s.role for s in plan.scenes]}")
    for i, (beat, ps) in enumerate(zip(script.beats, plan.scenes)):
        if not ps.needs_footage:
            continue
        words = len(beat.text.split())
        est_span = round(words / 2.5 * fps)  # ~2.5 words/sec; NO TTS here, so ESTIMATE
        videos = search_pexels(ps.query, key).get("videos", [])
        usable = any(pick_video_file(v.get("video_files", [])) for v in videos)
        _report(f"beat {i} (~{words}w, est span {est_span}f)", ps.query, videos, fps=fps,
                span_frames=est_span, broad_query=plan.title, thumbs_dir=thumbs_dir, top_n=top_n, tag=f"b{i}")
        if not usable:
            print("  -> WHIFF: no usable portrait clip; broadening to title")
            bvideos = search_pexels(plan.title, key).get("videos", [])
            _report(f"beat {i} [broadened]", plan.title, bvideos, fps=fps, span_frames=est_span,
                    thumbs_dir=thumbs_dir, top_n=top_n, tag=f"b{i}_broad")


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--topic", help="grounded script -> recipe -> per-beat queries (needs DEEPSEEK+TAVILY+PEXELS)")
    ap.add_argument("--query", action="append", default=[], help="Pexels-only; repeatable (needs PEXELS)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--thumbs", help="dir to download top-N thumbnails into (for the eyes-on relevance read)")
    ap.add_argument("--top-n", type=int, default=8)
    ap.add_argument("--span", type=int, help="span frames for --query loop-factor (optional)")
    args = ap.parse_args()

    from pipeline.config import require_env
    pexels_key = require_env("PEXELS_API_KEY")

    for i, q in enumerate(args.query):
        videos = search_pexels(q, pexels_key).get("videos", [])
        _report(f"query[{i}]", q, videos, fps=args.fps, span_frames=args.span,
                thumbs_dir=args.thumbs, top_n=args.top_n, tag=f"q{i}")

    if args.topic:
        _run_topic(args.topic, fps=args.fps, thumbs_dir=args.thumbs, top_n=args.top_n, key=pexels_key)
