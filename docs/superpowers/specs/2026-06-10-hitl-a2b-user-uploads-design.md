# HITL A.2b — User Uploads (footage + images) — Design

**Date:** 2026-06-10
**Branch:** `hitl-a2b-user-uploads` (off `development`; PR → `development`, never master)
**Status:** Operator-approved (architecture + all sub-decisions ratified against ground truth). Implementation plan follows.

The second cycle of **A.2** (media override), after **A.2a provenance** (merged, PR #11). A.2b lets a
user supply their **own video or image** file to replace one **footage scene's** clip — a third
footage edit op (`upload`) alongside `pick`/`re_query`, stamped `source="uploaded"`. The actual
file-picker UI is A.6; A.2b builds the programmatic session op + the media handling it needs.

## 0. Scope (ratified)

**In:**
- A third footage edit op `upload(scene_index, file)` in `engine._edit_footage`, accepting a local
  **video OR image** file for a footage scene.
- `Clip` gains a `kind` field; `assemble._scene_media` emits `Media.type` from it (so an uploaded
  image renders as an image).
- Hybrid file inspection: **extension** decides kind; **ffprobe** measures video duration (so a
  short uploaded video loops to fill the span). Isolated in a new `pipeline/media_probe.py`.
- Provenance `source="uploaded"` (the slot `_VALID_SOURCES` already reserves), `query` = the
  uploaded basename (inert display label).

**Deferred (own later cycles / locked elsewhere):**
- The A.6 gate **UI / preview API / frontend** that calls `upload` (the file-picker, drag-drop).
  A.2b is the programmatic op only — backend-first, exactly as the A.1 design sequenced it.
- DeepSeek-driven re-query — **A.2c**.
- Audio/voiceover/music uploads, brand-logo overlays, uploads to **non-footage** scenes — out of
  the A.2 media-override scope.
- Added **image Ken Burns motion** tuning — images get the same default `KenBurns()` as video
  clips today; per-kind motion design is a separate concern (YAGNI).
- The layout⊥theme override UI / `derive()` selector — a different, separately-locked surface;
  A.2b touches none of it.

## 1. Non-negotiable invariants

1. **Autopilot `spec.json` byte-identical.** With no upload, the rendered spec is unchanged.
   Verified ground truth: `Media.type` is a **required** field (`schema.py` — `type:
   Literal["video","image"]`, no default), so it is already emitted on every footage Media today
   (confirmed in the live `remotion/public/spec.json`: the footage scene carries `"type":"video"`).
   `Clip.kind` defaults to `"video"`, so `_scene_media` emitting `type=clip.kind` produces the
   **byte-identical** `"type":"video"` for auto clips. Pinned by the golden test (§7).
2. **An upload deliberately changes the rendered clip.** Unlike A.2a (session-only), the user's
   file becomes the scene's media — that IS the feature. Byte-identity is asserted only for the
   *no-upload* (autopilot) path; the upload edit legitimately re-derives `spec.json`.
3. **Renderer untouched.** `templates/scene/Component.tsx` already branches `media.type === 'video'`
   → `OffthreadVideo`/`Video(loop)` vs the else (`image`) → `<Img … objectFit: media.fit>`, both
   under the same outer Ken Burns transform. A.2b adds **no** Remotion code. (The image branch is
   code-present but un-exercised on the scene template — hence the §7 eyes-on, not a code change.)
4. **Fail-loud, require-measurable-video.** A video whose duration ffprobe cannot read is rejected,
   so every bound video clip has a known duration and loops correctly (parity with footage clips,
   which always carry duration). Images carry no duration and never loop.
5. **Local-first, near-$0.** ffprobe is already on PATH; no new Python dependency. `_VALID_SOURCES`
   extends by one string — no schema migration.

## 2. Contract change (`Clip` + assemble)

**`pipeline/contracts.Clip`** gains one field:

```python
    kind: str = "video"   # "video" | "image" — render media type; default keeps autopilot byte-identical
```

Default `"video"` keeps every existing construction and the autopilot spec byte-identical;
`codecs.clips_to_json`/`from_json` round-trip it automatically (`asdict`/`Clip(**c)`), and old
persisted footage JSON still loads (missing key → default).

**`pipeline/assemble._scene_media`** ([assemble.py:71-75]) emits the kind and gates loop on it:

```python
def _scene_media(clip, span_frames: int) -> Media:
    loop = clip.kind == "video" and clip.duration_frames is not None and clip.duration_frames < span_frames
    return Media(type=clip.kind, src=clip.path, fit="cover", kenBurns=KenBurns(), loop=loop)
```

For an auto/pick/re_query (video) clip this is identical to today. For an image clip: `type="image"`,
`loop=False` (the `<Img>` renders for the full scene span). Same `KenBurns()` default for both.

## 3. The upload op (`engine._edit_footage`, `op="upload"`)

The op is invoked as `engine.edit("footage", {"op": "upload", "scene_index": …, "file": …})`. The
existing `edit()` wrapper ([engine.py:123-134]) already does the routing **and** the
`invalidate("footage") → advance {assemble} → materialize_spec()` after `_edit_footage` returns — so
the upload branch must **not** re-implement invalidation/re-derive (parity with how the `pick`/
`re_query` branches leave that to `edit()`). The new branch lives in `_edit_footage` beside
`re_query`/`pick` ([engine.py:142-156]) and does only steps 1–5:

1. **Validate + classify.** `file = op["file"]`. If the path doesn't exist → `RuntimeError`
   (fail-loud). `kind = media_probe.kind_from_extension(file)` (video/image allowlist); an
   unsupported extension → `ValueError` (raised by `kind_from_extension`).
2. **Measure.** `video` → `dur_s = media_probe.ffprobe_duration_seconds(file)`; ffprobe failure
   (missing binary / non-zero / unparseable / empty) → `RuntimeError` (require-measurable-video);
   `duration_frames = round(dur_s * fps)`. `image` → `duration_frames = None` (no probe).
3. **Stage the file.** Copy into `ctx.assets_dir` as
   `footage_upload_s{scene}_{slug(stem)}_{hash8}{ext}` where `stem`/`ext` are the basename's stem
   and (lowercased) extension and `hash8` is the first 8 hex of a sha256 of the file bytes — so
   different content can't silently overwrite, same content is idempotent. `path = f"assets/{name}"`.
   (Note: the provenance `query` in step 5 keeps the **full** basename incl. extension for the badge;
   only the on-disk filename uses the stem.)
4. **Bind the clip.** `Clip(index=scene, query=<basename>, path=path, duration_frames=…, kind=kind,
   rank=None, pexels_id=None, pexels_url=None)`. Replace the scene's clip in the footage output's
   `clips` (matched by `index`); persist the footage `output_json` (same `upsert_stage` the other
   branches use).
5. **Provenance.** `store.upsert_provenance(scene, source="uploaded", query=<basename>, rank=None,
   pexels_id=None, pexels_url=None)` — the last statement, mirroring the `pick`/`re_query` stamp.

The `edit()` wrapper then invalidates `{assemble, render}`, re-derives assemble, and materializes the
new `spec.json` (the scene's media now points to the uploaded file with the right `type`).

**The Pexels candidate pool is left untouched.** An upload is not a pool member — like the
broaden-after-whiff case, the selected clip isn't in the displayed pool, and the A.6 badge reads
provenance (`source="uploaded"`), not the pool's `selected` flag. `footage_candidates` is not written.

**Orphaned files.** Re-uploading or `re_query`-ing over a scene leaves the prior staged file in
`assets_dir` — deliberately, matching how `pick`/`re_query` already leave prior downloads; the dir is
a gitignored cache and the latest `spec.json` simply stops referencing it. No deletion logic (avoids
removing a file another session/spec may reference).

## 4. `pipeline/media_probe.py` (isolated ffprobe)

A small module so `footage.py`'s deliberate no-ffprobe stance stays intact and the subprocess is
unit-testable behind an injectable runner:

```python
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}

def kind_from_extension(path) -> str:
    """'video' | 'image' from the file extension; ValueError on anything else."""

def ffprobe_duration_seconds(path, *, run=None) -> float:
    """Duration in seconds via `ffprobe -show_entries format=duration`. `run` is an injectable
    subprocess runner (defaults to subprocess.run) for tests. Fail-loud (RuntimeError) on a
    missing binary, non-zero exit, or empty/unparseable output — never returns None/0 silently."""
```

## 5. Provenance (`source="uploaded"`)

`store._VALID_SOURCES` extends by one string — the slot A.2a reserved, **no migration** (the column
is plain `TEXT`):

```python
_VALID_SOURCES = {"auto", "pick", "re_query", "uploaded"}
```

The upload stamps `source="uploaded"`, `query=<basename>` (e.g. `"beach-sunset.mp4"` → the A.6 badge
renders "uploaded: beach-sunset.mp4"), `rank/pexels_id/pexels_url = None`. **`query` is inert** —
verified: `re_query` sources its search from `op["query"]` (the caller's fresh query,
[engine.py:144]), never a clip's stored `query`; auto builds from `harden(beat.keywords)`; `pick`
reads the pool; assemble uses only `path`/`duration_frames`/`kind`. Nothing ever re-runs a stored
`query` as a Pexels search, so a basename label is display-only and cannot leak into a search.

## 6. Testing

- **`media_probe`:** `kind_from_extension` for video/image/unsupported (ValueError);
  `ffprobe_duration_seconds` returns seconds for a faked runner; fail-loud on non-zero exit, empty
  output, unparseable output (RuntimeError) — runner injected, no real subprocess in unit tests.
- **Upload op (engine):** `upload` of a video binds a `kind="video"` clip with the probed
  `duration_frames`, stamps `source="uploaded"` + `query=basename`, invalidates assemble, and the
  new `spec.json` scene media is the uploaded path; `upload` of an image binds `kind="image"`,
  `duration_frames=None`, and the spec media is `type="image"`, `loop=false`; an un-probeable video
  and a missing file and a bad extension each fail loud; the Pexels pool row count is unchanged
  (pool untouched). A faked ffprobe runner + a tmp file keep it offline.
- **assemble `_scene_media`:** an image clip → `Media(type="image", loop=False)`; a video clip
  shorter than its span → `loop=True`; longer/unknown → `loop=False`.
- **Autopilot golden (invariant #1):** the existing byte-identity test stays green with `Clip.kind`
  present — `spec.json` is byte-identical because auto clips are `kind="video"`.
- Full A.2a + A.1 regression stays green.

## 7. Eyes-on gate (the visual rule — motion, not stills)

The golden test proves the *no-upload* path is untouched and says nothing about the *with-upload*
render — which is the whole feature — and the scene-template image branch, though code-present, has
never rendered pixels. So before merge, an eyes-on with **motion clips** (operator supplies two files
in `/mnt/user-data/uploads`):

- **One short-looping uploaded video** — checks the measure-then-loop seam riding under the Ken
  Burns scale (a temporal artifact a still frame can't show).
- **One non-portrait uploaded image** — checks the `objectFit: cover` crop *in motion* under Ken
  Burns (cover-crop reads differently moving than frozen).

These two clips are also the cheapest possible disproof of "renderer needs no changes." Render each
through a real session `upload` → assemble → Remotion render; paste the motion frames; the operator
makes the merge call. (Build proceeds first; the render pauses for the operator's two files.)

## 8. Out of scope (explicit)

The A.6 gate UI / preview API / frontend file-picker; DeepSeek re-query (A.2c); audio/voiceover/logo
uploads; uploads to non-footage scenes; per-kind Ken Burns motion; the layout⊥theme `derive()`
selector. A.2b is the programmatic upload edit-op + its media handling only.
