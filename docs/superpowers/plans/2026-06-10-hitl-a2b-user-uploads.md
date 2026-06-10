# HITL A.2b — User Uploads (footage + images) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third footage edit op — `upload(scene_index, file)` — that binds a user-supplied **video or image** file to one footage scene, stamped `source="uploaded"`, while keeping the autopilot `spec.json` byte-identical.

**Architecture:** `Clip` gains a `kind` field (default `"video"`); `assemble._scene_media` emits `Media.type` from it and gates `loop` on it. A new isolated `pipeline/media_probe.py` classifies a file by extension and measures video duration via an injectable ffprobe runner (fail-loud). A new `upload` branch in `engine._edit_footage` validates → classifies → measures → stages (content-hashed filename) → binds the clip → stamps provenance; the existing `edit()` wrapper owns invalidate/re-derive. `store._VALID_SOURCES` extends by one string — no migration. The Remotion renderer is untouched (the scene template already branches on `media.type`).

**Tech Stack:** Python 3.12, pytest, SQLite (`session/store.py`), dataclasses (`pipeline/contracts.py`), Pydantic schema (`schema.py`), ffprobe (already on PATH).

---

## File Structure

- **Modify** `backend/pipeline/contracts.py` — add `Clip.kind: str = "video"`.
- **Modify** `backend/pipeline/assemble.py` — `_scene_media` emits `type=clip.kind`, gates loop on `kind == "video"`.
- **Create** `backend/pipeline/media_probe.py` — `kind_from_extension`, `slug`, `ffprobe_duration_seconds` (injectable runner).
- **Create** `backend/tests/test_media_probe.py` — unit tests for the probe (no real subprocess).
- **Modify** `backend/session/store.py` — `_VALID_SOURCES += {"uploaded"}`.
- **Modify** `backend/session/engine.py` — `upload` branch in `_edit_footage`.
- **Modify** `backend/tests/test_assemble.py` — image/video `_scene_media` loop cases.
- **Create** `backend/tests/test_session_upload_gate.py` — engine upload op end-to-end (faked ffprobe, tmp files).

Codecs need **no change**: `clips_to_json` uses `asdict` (picks up `kind` automatically) and `clips_from_json` uses `Clip(**c)` (old JSON missing `kind` → default).

---

## Task 1: `Clip.kind` contract field

**Files:**
- Modify: `backend/pipeline/contracts.py:22-32`
- Test: `backend/tests/test_session_codecs.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_session_codecs.py`:

```python
def test_clip_kind_round_trips_and_defaults_video():
    from pipeline.contracts import Clip
    from session.codecs import clips_to_json, clips_from_json

    # default kind is "video"
    c = Clip(index=0, query="q", path="assets/x.mp4", duration_frames=10)
    assert c.kind == "video"

    # an image clip round-trips through the footage codec
    img = Clip(index=1, query="pic.png", path="assets/pic.png",
               duration_frames=None, kind="image")
    restored = clips_from_json(clips_to_json([c, img]))
    assert restored[0].kind == "video"
    assert restored[1].kind == "image"

    # legacy JSON missing the key loads with the default (forward-compat)
    legacy = [{"index": 0, "query": "q", "path": "assets/x.mp4",
               "duration_frames": 10}]
    assert clips_from_json(legacy)[0].kind == "video"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_codecs.py::test_clip_kind_round_trips_and_defaults_video -v`
Expected: FAIL with `AttributeError`/`TypeError` — `Clip` has no `kind`.

- [ ] **Step 3: Add the field**

In `backend/pipeline/contracts.py`, inside the `Clip` dataclass, add `kind` immediately after `duration_frames` (before the A.2a provenance fields):

```python
@dataclass
class Clip:
    index: int  # beat index (scene position) this clip belongs to
    query: str
    path: str  # relative to remotion/public/, e.g. "assets/footage_ab12cd34.mp4"
    duration_frames: int | None = None  # clip length; None if unknown (no loop fallback)
    kind: str = "video"  # "video" | "image" — render media type; default keeps autopilot spec byte-identical
    # A.2a media provenance — surfaced from select_clip's real choice; None until set
    # (and for legacy pre-A.2a cached clips). Render-irrelevant: assemble ignores these.
    rank: int | None = None          # 1-based position among USABLE clips in the chosen search
    pexels_id: int | None = None     # Pexels video object id of the chosen clip
    pexels_url: str | None = None    # Pexels page url of the chosen clip
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_codecs.py::test_clip_kind_round_trips_and_defaults_video -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/contracts.py backend/tests/test_session_codecs.py
git commit -m "feat(a2b): add Clip.kind field (default video), codec round-trip"
```

---

## Task 2: `assemble._scene_media` emits kind + gates loop

**Files:**
- Modify: `backend/pipeline/assemble.py:71-75`
- Test: `backend/tests/test_assemble.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_assemble.py`:

```python
def test_scene_media_emits_kind_and_gates_loop():
    from pipeline.assemble import _scene_media
    from pipeline.contracts import Clip

    # video shorter than its span → loops
    short_vid = Clip(index=0, query="q", path="assets/v.mp4", duration_frames=10)
    m = _scene_media(short_vid, span_frames=30)
    assert m.type == "video" and m.loop is True

    # video longer than span → no loop
    long_vid = Clip(index=0, query="q", path="assets/v.mp4", duration_frames=90)
    assert _scene_media(long_vid, span_frames=30).loop is False

    # video with unknown duration → no loop
    unk = Clip(index=0, query="q", path="assets/v.mp4", duration_frames=None)
    assert _scene_media(unk, span_frames=30).loop is False

    # image → type image, never loops (even with a tiny duration)
    img = Clip(index=0, query="pic.png", path="assets/pic.png",
               duration_frames=5, kind="image")
    mi = _scene_media(img, span_frames=30)
    assert mi.type == "image" and mi.loop is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_assemble.py::test_scene_media_emits_kind_and_gates_loop -v`
Expected: FAIL — the image case gets `type == "video"` (hardcoded) and `loop is True`.

- [ ] **Step 3: Update `_scene_media`**

Replace `backend/pipeline/assemble.py:71-75` with:

```python
def _scene_media(clip, span_frames: int) -> Media:
    """Footage media for a scene span. Emits the clip's media `kind` and loops iff
    it is a VIDEO known-shorter than the span the renderer plays it for (dᵢ + Tᵢ).
    Images (kind='image') carry no duration and never loop — the <Img> renders for
    the full span."""
    loop = clip.kind == "video" and clip.duration_frames is not None and clip.duration_frames < span_frames
    return Media(type=clip.kind, src=clip.path, fit="cover", kenBurns=KenBurns(), loop=loop)
```

- [ ] **Step 4: Run the new test + the autopilot golden (invariant #1)**

Run: `cd backend && .venv/bin/python -m pytest tests/test_assemble.py::test_scene_media_emits_kind_and_gates_loop tests/test_session_autopilot_golden.py -v`
Expected: PASS — the new test passes AND the byte-identity golden stays green (auto clips are `kind="video"`, so `type="video"` is byte-identical).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/assemble.py backend/tests/test_assemble.py
git commit -m "feat(a2b): _scene_media emits Media.type from clip.kind, gates loop on video"
```

---

## Task 3: `pipeline/media_probe.py` (isolated, injectable ffprobe)

**Files:**
- Create: `backend/pipeline/media_probe.py`
- Test: `backend/tests/test_media_probe.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_media_probe.py`:

```python
"""A.2b — media_probe: extension → kind, and a fail-loud injectable ffprobe duration.
No real subprocess runs here; the runner is faked."""
import types
import pytest

from pipeline import media_probe


def _runner(*, returncode=0, stdout="", stderr=""):
    def run(cmd, capture_output=True, text=True):
        return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)
    return run


def test_kind_from_extension_video_image_and_unsupported():
    assert media_probe.kind_from_extension("a/b/clip.MP4") == "video"
    assert media_probe.kind_from_extension("photo.JPG") == "image"
    assert media_probe.kind_from_extension("x.png") == "image"
    with pytest.raises(ValueError, match="unsupported upload extension"):
        media_probe.kind_from_extension("notes.txt")


def test_slug_lowercases_and_hyphenates():
    assert media_probe.slug("Beach Sunset!!") == "beach-sunset"
    assert media_probe.slug("___") == "upload"  # empty → safe fallback


def test_ffprobe_returns_seconds_for_ok_runner():
    dur = media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="3.5\n"))
    assert dur == 3.5


def test_ffprobe_fails_loud_on_nonzero_exit():
    with pytest.raises(RuntimeError, match="ffprobe failed"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(returncode=1, stderr="boom"))


def test_ffprobe_fails_loud_on_empty_output():
    with pytest.raises(RuntimeError, match="unparseable duration"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="   \n"))


def test_ffprobe_fails_loud_on_unparseable_output():
    with pytest.raises(RuntimeError, match="unparseable duration"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="N/A"))


def test_ffprobe_fails_loud_on_nonpositive_duration():
    with pytest.raises(RuntimeError, match="non-positive duration"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=_runner(stdout="0\n"))


def test_ffprobe_fails_loud_on_missing_binary():
    def boom(cmd, capture_output=True, text=True):
        raise FileNotFoundError("ffprobe")
    with pytest.raises(RuntimeError, match="ffprobe not available"):
        media_probe.ffprobe_duration_seconds("v.mp4", run=boom)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_media_probe.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.media_probe'`.

- [ ] **Step 3: Write the module**

Create `backend/pipeline/media_probe.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_media_probe.py -v`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/media_probe.py backend/tests/test_media_probe.py
git commit -m "feat(a2b): media_probe — extension->kind + fail-loud injectable ffprobe"
```

---

## Task 4: `store._VALID_SOURCES` accepts `"uploaded"`

**Files:**
- Modify: `backend/session/store.py:157`
- Test: `backend/tests/test_session_store.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_session_store.py`:

```python
def test_upsert_provenance_accepts_uploaded_source(tmp_path):
    from session import store
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    store.upsert_provenance(conn, "s1", 1, source="uploaded",
                            query="beach-sunset.mp4", rank=None,
                            pexels_id=None, pexels_url=None)
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "uploaded", "query": "beach-sunset.mp4",
                       "rank": None, "pexels_id": None, "pexels_url": None}
    conn.close()
```

(If `test_session_store.py` has a session-seeding helper, reuse it instead of the inline `create_session`; the assertion is what matters.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_store.py::test_upsert_provenance_accepts_uploaded_source -v`
Expected: FAIL with `ValueError: unknown provenance source 'uploaded'`.

- [ ] **Step 3: Extend the source set**

Replace `backend/session/store.py:157`:

```python
_VALID_SOURCES = {"auto", "pick", "re_query", "uploaded"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_store.py::test_upsert_provenance_accepts_uploaded_source -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/session/store.py backend/tests/test_session_store.py
git commit -m "feat(a2b): allow source='uploaded' in provenance (no migration)"
```

---

## Task 5: The `upload` op in `engine._edit_footage`

**Files:**
- Modify: `backend/session/engine.py:136-196`

This task adds the branch only; Task 6 tests it end-to-end. The branch is self-contained (own content-hashed filename, no Pexels pool, no `chosen`), so it does its own persist + provenance and **returns before** the shared re_query/pick code. It must **not** invalidate/re-derive — the `edit()` wrapper ([engine.py:128-134]) already does that after `_edit_footage` returns.

- [ ] **Step 1: Add the upload branch**

In `backend/session/engine.py`, the `_edit_footage` method currently begins:

```python
    def _edit_footage(self, op):
        from pipeline import footage as footage_stage
        from pipeline.contracts import Clip
        out = self._load_output("footage")
        scene = op["scene_index"]

        if op["op"] == "re_query":
```

Insert the upload branch **immediately after** `scene = op["scene_index"]` and **before** `if op["op"] == "re_query":`:

```python
        if op["op"] == "upload":
            self._upload_footage(out, scene, op)
            return

```

Then add this new method directly after `_edit_footage` (after its final `upsert_provenance(...)` call at engine.py:196):

```python
    def _upload_footage(self, out, scene, op):
        """A.2b — bind a user-supplied video OR image file to a footage scene.

        Self-contained: classifies by extension, measures a video's duration
        (fail-loud), stages the file under a content-hashed name so distinct
        content can't silently overwrite, binds a Clip (kind=video/image), persists
        the footage output, and stamps source='uploaded'. The Pexels candidate pool
        is left untouched (an upload is not a pool member). Returns to edit(), which
        invalidates {assemble, render} and re-derives the spec."""
        from pathlib import Path
        from pipeline import media_probe
        from pipeline.contracts import Clip

        file = Path(op["file"])
        if not file.exists():
            raise RuntimeError(f"upload: file not found: {file}")
        kind = media_probe.kind_from_extension(file)  # ValueError on bad extension

        if kind == "video":
            dur_s = media_probe.ffprobe_duration_seconds(file)  # RuntimeError if unmeasurable
            duration_frames = round(dur_s * self.ctx.fps)
        else:
            duration_frames = None  # images carry no duration; never loop

        basename = file.name                       # provenance label keeps the extension
        data = file.read_bytes()
        hash8 = hashlib.sha256(data).hexdigest()[:8]
        ext = file.suffix.lower()
        name = f"footage_upload_s{scene}_{media_probe.slug(file.stem)}_{hash8}{ext}"
        self.ctx.assets_dir.mkdir(parents=True, exist_ok=True)
        dest = self.ctx.assets_dir / name
        if not dest.exists():                      # same content (hash) → idempotent
            dest.write_bytes(data)

        new_clip = Clip(index=scene, query=basename, path=f"assets/{name}",
                        duration_frames=duration_frames, kind=kind,
                        rank=None, pexels_id=None, pexels_url=None)
        out["clips"] = [new_clip if c.index == scene else c for c in out["clips"]]

        to_json, _ = CODECS["footage"]
        store.upsert_stage(self.conn, self.sid, "footage", status="done",
                           input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                           output_json=json.dumps(to_json(out), default=str), now=_now())
        # Provenance: source='uploaded', query=basename (inert display label — never
        # re-run as a search). rank/pexels are None (not a Pexels result).
        store.upsert_provenance(self.conn, self.sid, scene, source="uploaded",
                                query=basename, rank=None, pexels_id=None, pexels_url=None)
```

(`hashlib`, `json`, `store`, and `CODECS` are already imported/defined at module top — no new top-level imports needed.)

- [ ] **Step 2: Verify the module imports cleanly**

Run: `cd backend && .venv/bin/python -c "from session import engine; print('ok')"`
Expected: `ok` (no syntax/import error).

- [ ] **Step 3: Commit**

```bash
git add backend/session/engine.py
git commit -m "feat(a2b): upload op in _edit_footage (video/image, content-hashed staging)"
```

---

## Task 6: Engine upload-op gate test (end-to-end, offline)

**Files:**
- Create: `backend/tests/test_session_upload_gate.py`

Mirrors `test_session_footage_gate.py`'s seed (faked script/tts/timing/pexels), then drives `eng.edit("footage", {"op": "upload", ...})` with a faked ffprobe and tmp files. Verifies: a video upload binds a `kind="video"` clip with the probed duration and `loop` semantics; an image upload yields `type="image"`, `loop=false`; provenance is `source="uploaded"` with the basename; timing is unchanged; the Pexels pool row count is unchanged; and the three fail-loud paths (missing file, bad extension, unprobeable video) raise.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_session_upload_gate.py`:

```python
"""HITL A.2b — the upload gate: an upload edit binds a user file (video OR image)
to a footage scene, emits the right Media.type/loop, stamps source='uploaded',
leaves timing + the Pexels pool untouched, and fails loud on bad input.

Offline: ffprobe is faked via media_probe.ffprobe_duration_seconds monkeypatch;
uploaded files are tmp_path bytes. Reuses the footage-gate seed shape."""
import json
from pathlib import Path

import pytest

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming
from pipeline import validate as validate_stage
from session import store, engine, executors

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _seed(tmp_path, monkeypatch):
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1))
                                              for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])
    pool = {"coral reef": [
        {"duration": 6, "video_files": [{"link": "first.mp4", "width": 1080, "height": 1920,
                                         "file_type": "video/mp4"}], "video_pictures": [{"picture": "t1"}]},
        {"duration": 9, "video_files": [{"link": "second.mp4", "width": 1080, "height": 1920,
                                         "file_type": "video/mp4"}], "video_pictures": [{"picture": "t2"}]},
    ]}
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pool.get(q, [])})
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog, assets_dir=tmp_path / "a",
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.run_all()
    return conn, eng


def _scene1_media(tmp_path):
    spec = json.loads((tmp_path / "spec.json").read_text())
    return spec["scenes"][1]["templateProps"]["media"]


def test_upload_video_binds_kind_video_loops_and_stamps_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    timing0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]
    pool_before = store.get_footage_candidates(conn, "s1", scene_index=1)

    # a 0.1s video (3 frames at 30fps) — shorter than scene-1's span → loops
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds",
                        lambda path, run=None: 0.1)
    f = tmp_path / "Beach Clip.mp4"
    f.write_bytes(b"VIDEOBYTES")
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})

    media = _scene1_media(tmp_path)
    assert media["type"] == "video"
    assert media["loop"] is True               # 3-frame clip < scene span
    assert "footage_upload_s1_beach-clip_" in media["src"]
    assert media["src"].endswith(".mp4")

    # timing unchanged; pool untouched
    spec1 = json.loads((tmp_path / "spec.json").read_text())
    assert [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]] == timing0
    assert store.get_footage_candidates(conn, "s1", scene_index=1) == pool_before

    prov = store.get_media_provenance(conn, "s1")[1]
    assert prov == {"source": "uploaded", "query": "Beach Clip.mp4",
                    "rank": None, "pexels_id": None, "pexels_url": None}
    conn.close()


def test_upload_image_binds_kind_image_no_loop(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)

    # ffprobe must NOT be called for an image — make it explode if it is
    def _boom(path, run=None):
        raise AssertionError("ffprobe must not run for an image upload")
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds", _boom)

    f = tmp_path / "sunset.png"
    f.write_bytes(b"PNGBYTES")
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})

    media = _scene1_media(tmp_path)
    assert media["type"] == "image"
    assert media["loop"] is False
    assert media["src"].endswith(".png")
    assert store.get_media_provenance(conn, "s1")[1]["source"] == "uploaded"
    conn.close()


def test_upload_missing_file_fails_loud(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    with pytest.raises(RuntimeError, match="file not found"):
        eng.edit("footage", {"op": "upload", "scene_index": 1,
                             "file": str(tmp_path / "nope.mp4")})
    conn.close()


def test_upload_bad_extension_fails_loud(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    f = tmp_path / "notes.txt"
    f.write_bytes(b"x")
    with pytest.raises(ValueError, match="unsupported upload extension"):
        eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    conn.close()


def test_upload_unprobeable_video_fails_loud(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)

    def _fail(path, run=None):
        raise RuntimeError("ffprobe failed (exit 1)")
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds", _fail)
    f = tmp_path / "broken.mp4"
    f.write_bytes(b"x")
    with pytest.raises(RuntimeError, match="ffprobe failed"):
        eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    conn.close()


def test_upload_same_content_is_idempotent_on_disk(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    monkeypatch.setattr("pipeline.media_probe.ffprobe_duration_seconds",
                        lambda path, run=None: 2.0)
    f = tmp_path / "clip.mp4"
    f.write_bytes(b"SAME")
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    staged = sorted((tmp_path / "a").glob("footage_upload_*"))
    eng.edit("footage", {"op": "upload", "scene_index": 1, "file": str(f)})
    assert sorted((tmp_path / "a").glob("footage_upload_*")) == staged  # no duplicate
    conn.close()
```

- [ ] **Step 2: Run the gate tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_upload_gate.py -v`
Expected: PASS (all 6 tests).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_session_upload_gate.py
git commit -m "test(a2b): engine upload gate — video/image bind, provenance, fail-loud, idempotent"
```

---

## Task 7: Full regression + eyes-on render gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: all green (A.2a + A.1 regression unchanged, plus the new A.2b tests). Record the count.

- [ ] **Step 2: Confirm the autopilot byte-identity invariant explicitly**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_autopilot_golden.py -v`
Expected: PASS — proves the no-upload path still emits a byte-identical `spec.json`.

- [ ] **Step 3: PAUSE for the operator's two upload files (eyes-on, motion)**

This is the visual gate from the spec §7 — **motion, not stills.** The operator drops two files in `/mnt/user-data/uploads`:
- **one short-looping video** (checks the measure→loop seam under Ken Burns), and
- **one non-portrait image** (checks `objectFit: cover` crop in motion under the default `KenBurns()` 1.0→1.12 zoom).

Do **not** self-supply files. Wait for the operator. Then for each file: drive a real session `upload` → assemble → Remotion render, and paste the motion frames. The operator makes the merge call. The golden test says nothing about the *with-upload* render (the whole feature) and the scene-template image branch has never rendered pixels — these two clips are the cheapest disproof of "renderer needs no changes."

- [ ] **Step 4: After operator sign-off — finishing the branch**

Use `superpowers:finishing-a-development-branch`: PR `hitl-a2b-user-uploads` → `development` (never master). Do not merge yourself.

---

## Self-Review

**Spec coverage:**
- §2 `Clip.kind` + assemble emit/loop → Tasks 1, 2. ✓
- §3 upload op (validate/classify, measure, stage content-hashed, bind, provenance), pool untouched, `edit()` owns re-derive → Task 5 + Task 6 assertions. ✓
- §4 `media_probe.py` (kind_from_extension, ffprobe injectable, fail-loud) → Task 3. ✓
- §5 `_VALID_SOURCES += "uploaded"`, query inert (basename, never searched) → Task 4 + provenance assertions. ✓
- §6 testing (media_probe, upload op video/image/fail-loud, assemble loop, golden) → Tasks 1,2,3,4,6,7. ✓
- §1 invariant #1 (byte-identical autopilot) → Task 2 step 4 + Task 7 step 2. ✓
- §7 eyes-on motion gate → Task 7 step 3. ✓
- §3 orphaned-files / idempotent staging → Task 6 `test_upload_same_content_is_idempotent_on_disk`. ✓

**Placeholder scan:** every code step shows complete code; no TBD/TODO. ✓

**Type consistency:** `Clip.kind` (str, default "video") used identically in contracts, `_scene_media`, codec test, and the upload `Clip(...)` construction; `media_probe.kind_from_extension`/`ffprobe_duration_seconds`/`slug` signatures match across module + both test files; `source="uploaded"` matches `_VALID_SOURCES`. ✓
