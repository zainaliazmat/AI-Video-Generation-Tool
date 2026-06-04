#!/usr/bin/env python3
"""Stdlib-only structural check for a spec file.

No dependencies — runnable right now in Phase 1 before the venv exists:
    python3 backend/check_sample.py            # checks ./sample-spec.json
    python3 backend/check_sample.py spec.json

Full validation (types, enums) lives in backend/schema.py via pydantic, which
is installed in Phase 4. This checker just confirms the contract's shape and
that referenced asset files actually exist under remotion/public/.
"""
from __future__ import annotations

import json
import os
import sys

PUBLIC_DIR = os.path.join("remotion", "public")
TOP_KEYS = ("meta", "audio", "scenes", "captions", "style")


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "sample-spec.json"
    if not os.path.exists(path):
        fail(f"{path} not found")

    with open(path, encoding="utf-8") as f:
        try:
            spec = json.load(f)
        except json.JSONDecodeError as e:
            fail(f"{path} is not valid JSON: {e}")

    for k in TOP_KEYS:
        if k not in spec:
            fail(f"missing top-level key: {k}")

    meta = spec["meta"]
    for k in ("title", "fps", "width", "height", "durationInFrames"):
        if k not in meta:
            fail(f"meta missing key: {k}")
    fps, total = meta["fps"], meta["durationInFrames"]

    # Scenes laid end to end; last scene end should equal meta.durationInFrames.
    scenes = spec["scenes"]
    if not scenes:
        fail("scenes is empty")
    cursor = 0
    missing_assets: list[str] = []
    for i, s in enumerate(scenes):
        for k in ("id", "startFrame", "durationInFrames", "media"):
            if k not in s:
                fail(f"scene[{i}] missing key: {k}")
        if s["startFrame"] != cursor:
            print(
                f"WARN: scene[{i}] startFrame={s['startFrame']} but expected "
                f"{cursor} (scenes should be contiguous)"
            )
        cursor = s["startFrame"] + s["durationInFrames"]
        media = s["media"]
        for k in ("type", "src"):
            if k not in media:
                fail(f"scene[{i}].media missing key: {k}")
        if media["type"] not in ("video", "image"):
            fail(f"scene[{i}].media.type invalid: {media['type']}")
        asset = os.path.join(PUBLIC_DIR, media["src"])
        if not os.path.exists(asset):
            missing_assets.append(asset)

    if cursor != total:
        print(
            f"WARN: scenes span {cursor} frames but meta.durationInFrames={total}"
        )

    # Audio assets.
    audio = spec["audio"]
    if "voiceover" not in audio:
        fail("audio missing 'voiceover'")
    vo = os.path.join(PUBLIC_DIR, audio["voiceover"])
    if not os.path.exists(vo):
        missing_assets.append(vo)
    if audio.get("music"):
        mus = os.path.join(PUBLIC_DIR, audio["music"])
        if not os.path.exists(mus):
            missing_assets.append(mus)

    # Captions: one entry per word, ascending, start < end.
    captions = spec["captions"]
    if not captions:
        fail("captions is empty")
    last_end = -1
    for i, c in enumerate(captions):
        for k in ("text", "startFrame", "endFrame"):
            if k not in c:
                fail(f"caption[{i}] missing key: {k}")
        if c["startFrame"] >= c["endFrame"]:
            fail(f"caption[{i}] '{c['text']}': startFrame >= endFrame")
        if c["startFrame"] < last_end:
            print(f"WARN: caption[{i}] '{c['text']}' overlaps the previous word")
        if c["endFrame"] > total:
            print(f"WARN: caption[{i}] '{c['text']}' ends past durationInFrames")
        last_end = c["endFrame"]

    if missing_assets:
        fail("referenced assets do not exist:\n  - " + "\n  - ".join(missing_assets))

    secs = total / fps if fps else 0
    print(
        f"OK: {path} — {len(scenes)} scenes, {len(captions)} caption words, "
        f"{total} frames ({secs:.1f}s @ {fps}fps), all {len(scenes) + 1 + (1 if audio.get('music') else 0)} assets present."
    )


if __name__ == "__main__":
    main()
