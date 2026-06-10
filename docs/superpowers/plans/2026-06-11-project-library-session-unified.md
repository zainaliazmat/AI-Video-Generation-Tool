# Project Library (session-unified) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every generated/rendered video a persistent, re-openable project that survives refresh, route change, and server restart — by promoting the *session that each generation already mints* into the unit of persistence (session = project).

**Architecture:** A generation already mints a session id (`sid`) and a SQLite row (`backend/.sessions/sessions.db`). Today every session materializes to ONE global `spec.json` and ONE `voiceover.wav`, so older sessions get clobbered. This plan makes those artifacts **per-session**: each session writes `projects/<sid>/{spec,sources,meta}.json` (+ `video.mp4` after render) and a namespaced `assets/voiceover_<sid>.wav` (never overwritten → pixel-perfect re-preview). The library lists `projects/*/` by directory scan; opening a project loads that session's spec into the Player AND re-binds the footage gate to that session; render stages that session's spec. One id (`sid`), one persistence layer. The repo-root `spec.json` is retired as a source of truth.

**Tech Stack:** Python 3.12 + pytest (backend pipeline + session engine), Next.js 15 App Router / TypeScript (preview API + UI), Remotion CLI (render).

**Supersedes:** `docs/superpowers/plans/2026-06-08-project-library.md` (written before the A.1 session spine merged; it introduced a *parallel* `mint_project_id` + `projects/` tree blind to the fact that sessions already exist). This plan reuses that design's locked decisions (spec `docs/superpowers/specs/2026-06-08-project-library-design.md`) but maps "project" onto the existing session instead of beside it.

---

## Reconciliation note (what changed vs the 2026-06-08 plan, and why)

Read this before starting — it explains every divergence from the old plan.

| Old plan assumed | Ground truth now (post A.1–A.6) | This plan does |
|---|---|---|
| No project ids exist → mint `YYYYMMDD-HHMM-slug` | Every generation already mints `sid` (`auto-<uuid>`) + a SQLite row ([main.py:91](../../../backend/main.py#L91)) | **Reuse `sid` as the project id.** No `mint_project_id`/`slugify`. Human-readable rows come from `meta.json.title`, not the id. |
| `build_spec` called from `main.run` | `build_spec` is called by the engine's assemble executor ([executors.py:142](../../../backend/session/executors.py#L142)) | Thread the namespaced voiceover through `run_assemble`, not `main.run`. |
| Player takes spec as a prop; "no file involved" | Player IS prop-driven (`<PlayerClient spec={spec}/>`), but `Studio` populates that prop by fetching the global static `/spec.json` in 3 places | Re-point those fetches at `/api/projects/<sid>` (the selected session's spec). |
| Footage gate not considered | Footage gate (`session_state.py`) reads the **global** `job_ctx.SPEC_OUT` ([session_state.py:25](../../../backend/session_state.py#L25)); edits re-materialize the global spec | Make the gate read the **session's own** spec. Bonus: opening an *old* project re-binds its gate for free (the parallel-tree design couldn't). |
| Delete = remove folder + voiceover | A session also owns SQLite rows (stages, footage_candidates, media_provenance) | Delete also purges the SQLite session, via a Python CLI (`session_delete.py`) the route spawns — all sqlite access stays in Python. |
| Render route takes a body / project id | Render route takes **no body**; `npm run render` → `copy-spec.mjs` stages `public/spec.json` from `SPEC_PATH` env (or root `spec.json`, or sample) | Render route accepts `{id}`, passes `SPEC_PATH=projects/<id>/spec.json`, copies `out/video.mp4` → `projects/<id>/video.mp4`. |

**Per-session path mapping (the core mechanical change):**

```
ctx.spec_out      REPO_ROOT/spec.json              → projects/<sid>/spec.json
ctx.sources_out   REPO_ROOT/sources.json           → projects/<sid>/sources.json
ctx.voiceover_path assets/voiceover.wav            → assets/voiceover_<sid>.wav   (shared pool, never overwritten)
(new)             —                                → projects/<sid>/meta.json      (list sidecar)
(new, on render)  remotion/out/video.mp4 (transient)→ projects/<sid>/video.mp4
```

Media (footage + namespaced voiceover) stays in `remotion/public/assets/`, so the existing `copy-assets` mirror and `staticFile("assets/...")` resolution keep working unchanged. `remotion/public/spec.json` remains a *transient render input* (staged per render); the repo-root `spec.json` stops being written.

---

## File Structure

**Backend (Python):**
- Create `backend/pipeline/projects.py` — per-session path helpers + `meta.json` writer (pure, testable). No id minting (sid already exists).
- Create `backend/tests/test_projects.py` — unit tests for the above.
- Create `backend/session_delete.py` — CLI: purge SQLite session + remove `projects/<sid>/` + namespaced voiceover (both asset roots).
- Create `backend/tests/test_session_delete.py` — unit test for the delete path.
- Modify `backend/pipeline/assemble.py` — parametrize the voiceover path in `build_spec`.
- Modify `backend/session/executors.py` — `run_assemble` passes the namespaced voiceover rel from ctx.
- Modify `backend/session/job_ctx.py` — `build_ctx(sid=...)` computes per-session paths.
- Modify `backend/main.py` — per-session ctx, write `meta.json`, stop writing root `spec.json`/`sources.json`.
- Modify `backend/session_state.py` — read the session's OWN spec, not the global one.
- Modify `backend/session/store.py` — add `delete_session(conn, sid)`.

**Frontend API (TypeScript):**
- Create `preview/lib/projects.ts` — `ProjectMeta` type + traversal-safe id validation + repo-path helpers.
- Create `preview/app/api/projects/route.ts` — `GET` list (directory scan).
- Create `preview/app/api/projects/[id]/route.ts` — `GET` spec+sources, `DELETE` project.
- Create `preview/app/api/projects/[id]/video/route.ts` — `GET` stream MP4 (range support).
- Modify `preview/app/api/render/route.ts` — accept `id`, stage that project's spec via `SPEC_PATH`, archive the MP4.
- Modify `preview/app/api/generate/route.ts` — drop the dead `spec:'/spec.json'` from the `done` event (keep `sid`).
- Modify `preview/scripts/copy-assets.mjs` — drop the now-unused root-`spec.json` copy.

**Frontend UI:**
- Rewrite `preview/components/HistoryList.tsx` → server-backed project list (open / download / delete).
- Modify `preview/components/RenderControls.tsx` — render the selected project by `id`.
- Modify `preview/components/Studio.tsx` — server-backed list, selection, open-loads-spec-and-gate, empty state.

---

## Task 1: Backend — per-session paths + meta writer (pure logic, TDD)

**Files:**
- Create: `backend/pipeline/projects.py`
- Test: `backend/tests/test_projects.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_projects.py
import json
from pathlib import Path

from pipeline import projects


def test_project_dir_under_projects_root():
    root = Path("/repo")
    assert projects.project_dir(root, "auto-abc") == Path("/repo/projects/auto-abc")


def test_spec_sources_meta_video_paths():
    root = Path("/repo")
    d = root / "projects" / "auto-abc"
    assert projects.project_spec_path(root, "auto-abc") == d / "spec.json"
    assert projects.project_sources_path(root, "auto-abc") == d / "sources.json"
    assert projects.project_meta_path(root, "auto-abc") == d / "meta.json"
    assert projects.project_video_path(root, "auto-abc") == d / "video.mp4"


def test_voiceover_name_namespaced():
    assert projects.voiceover_name("auto-abc") == "voiceover_auto-abc.wav"


def test_write_meta_writes_one_file(tmp_path: Path):
    out = projects.write_meta(
        tmp_path, "auto-abc",
        meta={"id": "auto-abc", "title": "X", "createdAt": 123},
    )
    assert out == tmp_path / "projects" / "auto-abc" / "meta.json"
    loaded = json.loads(out.read_text())
    assert loaded["id"] == "auto-abc"
    assert loaded["title"] == "X"


def test_write_meta_creates_project_dir(tmp_path: Path):
    projects.write_meta(tmp_path, "auto-abc", meta={"id": "auto-abc"})
    assert (tmp_path / "projects" / "auto-abc").is_dir()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_projects.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'pipeline.projects'`

- [ ] **Step 3: Write the implementation**

```python
# backend/pipeline/projects.py
"""Project library — per-session snapshot directories under projects/<sid>/.

A "project" IS a session (the sid the pipeline already mints). Each session's
render contract (spec.json), grounding sidecar (sources.json), list sidecar
(meta.json) and — after a render — video.mp4 live in projects/<sid>/. Media stays
in the shared content-addressed assets pool; the per-session voiceover is
namespaced (voiceover_<sid>.wav) so it is never overwritten, which is what makes
pixel-perfect re-preview possible. No id minting here: the sid is the id.
"""
from __future__ import annotations

import json
from pathlib import Path


def projects_root(repo_root: Path) -> Path:
    return Path(repo_root) / "projects"


def project_dir(repo_root: Path, sid: str) -> Path:
    return projects_root(repo_root) / sid


def project_spec_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "spec.json"


def project_sources_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "sources.json"


def project_meta_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "meta.json"


def project_video_path(repo_root: Path, sid: str) -> Path:
    return project_dir(repo_root, sid) / "video.mp4"


def voiceover_name(sid: str) -> str:
    return f"voiceover_{sid}.wav"


def write_meta(repo_root: Path, sid: str, *, meta: dict) -> Path:
    d = project_dir(repo_root, sid)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "meta.json"
    out.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_projects.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/projects.py backend/tests/test_projects.py
git commit -m "feat(projects): per-session path helpers + meta writer"
```

---

## Task 2: Backend — parametrize voiceover path in `build_spec` + thread it through the assemble executor

**Files:**
- Modify: `backend/pipeline/assemble.py:80,133`
- Modify: `backend/session/executors.py:142`
- Test: `backend/tests/test_assemble.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_assemble.py` (mirror the file's existing `build_spec` test construction — reuse its fixtures/inline inputs for `plan`, `offsets`, `words`, `clips`, `catalog`):

```python
def test_build_spec_uses_custom_voiceover_path(plan, offsets, words, clips, catalog):
    spec = assemble.build_spec(
        plan, offsets, words, clips, catalog=catalog, fps=30,
        voiceover_rel="assets/voiceover_auto-abc.wav",
    )
    assert spec.audio.voiceover == "assets/voiceover_auto-abc.wav"


def test_build_spec_default_voiceover_path(plan, offsets, words, clips, catalog):
    spec = assemble.build_spec(plan, offsets, words, clips, catalog=catalog, fps=30)
    assert spec.audio.voiceover == "assets/voiceover.wav"
```

> If `test_assemble.py` builds inputs inline rather than via fixtures, mirror that file's construction for these two tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_assemble.py -k voiceover -v`
Expected: FAIL — `build_spec() got an unexpected keyword argument 'voiceover_rel'`

- [ ] **Step 3: Implement the change in `build_spec`**

In `backend/pipeline/assemble.py`, add a keyword param to `build_spec` (signature near line 80) and use it at line 133:

```python
def build_spec(
    plan, offsets, words, clips, *, catalog, fps,
    voiceover_rel: str = "assets/voiceover.wav",
):
    ...
        audio=Audio(voiceover=voiceover_rel, music=music, musicVolumeDb=-18.0),
```

Keep the rest of `build_spec` unchanged; only the signature line and the `Audio(...)` line change.

- [ ] **Step 4: Thread it through the assemble executor**

In `backend/session/executors.py`, change `run_assemble` (line 142) to pass the ctx voiceover's filename:

```python
    return assemble_stage.build_spec(
        plan, offsets, words, clips, catalog=ctx.catalog, fps=ctx.fps,
        voiceover_rel=f"assets/{ctx.voiceover_path.name}",
    )
```

> `ctx.voiceover_path` is `.../assets/voiceover_<sid>.wav` once Task 4 lands; `.name` yields `voiceover_<sid>.wav`. With the current global ctx (`voiceover.wav`) this is identity, so existing engine tests keep passing.

- [ ] **Step 5: Run the assemble + engine tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_assemble.py tests/test_session_engine.py tests/test_session_executors.py -v`
Expected: PASS (existing tests + the two new ones)

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/assemble.py backend/session/executors.py backend/tests/test_assemble.py
git commit -m "feat(assemble): parametrize voiceover path; executor passes per-session rel"
```

---

## Task 3: Backend — per-session paths in `build_ctx`

**Files:**
- Modify: `backend/session/job_ctx.py`
- Test: `backend/tests/test_job_ctx.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_job_ctx.py
from session import job_ctx


def test_build_ctx_default_is_global_paths():
    ctx = job_ctx.build_ctx(topic="t")
    assert ctx.spec_out == job_ctx.SPEC_OUT
    assert ctx.voiceover_path.name == "voiceover.wav"


def test_build_ctx_sid_uses_per_session_paths():
    ctx = job_ctx.build_ctx(topic="t", sid="auto-abc")
    assert ctx.spec_out == job_ctx.REPO_ROOT / "projects" / "auto-abc" / "spec.json"
    assert ctx.sources_out == job_ctx.REPO_ROOT / "projects" / "auto-abc" / "sources.json"
    assert ctx.voiceover_path.name == "voiceover_auto-abc.wav"
    assert ctx.voiceover_path.parent == job_ctx.ASSETS_DIR
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_job_ctx.py -v`
Expected: FAIL — `build_ctx() got an unexpected keyword argument 'sid'`

- [ ] **Step 3: Implement**

In `backend/session/job_ctx.py`, import the projects helper and branch on `sid`:

```python
from pipeline import projects as projects_mod


def build_ctx(*, topic: str, fps: int = 30, sid: str | None = None) -> EngineContext:
    if sid is None:
        spec_out, sources_out, voiceover_path = SPEC_OUT, SOURCES_OUT, ASSETS_DIR / "voiceover.wav"
    else:
        spec_out = projects_mod.project_spec_path(REPO_ROOT, sid)
        sources_out = projects_mod.project_sources_path(REPO_ROOT, sid)
        voiceover_path = ASSETS_DIR / projects_mod.voiceover_name(sid)
    return EngineContext(
        topic=topic, fps=fps, theme=Theme(),
        catalog=validate_stage.load_catalog(TEMPLATES_DIR),
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=voiceover_path,
        spec_out=spec_out, sources_out=sources_out)
```

> `sid=None` preserves today's global-path behavior so existing callers/tests that don't care about per-session paths keep working. The real call sites (Task 4 `main.run`, Task 5 `session_state`, Task 5 `session_edit`) pass `sid`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_job_ctx.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/session/job_ctx.py backend/tests/test_job_ctx.py
git commit -m "feat(job_ctx): per-session spec/sources/voiceover paths when sid given"
```

---

## Task 4: Backend — `main.run()` writes per-session artifacts; stop writing root spec

**Files:**
- Modify: `backend/main.py`
- Test: `backend/tests/test_main.py` (update existing assertions)

This is integration glue verified end-to-end (Task 13), plus the existing `test_main.py` retargeted off the root spec.

- [ ] **Step 1: Read the existing `test_main.py` assertions**

Run: `cd backend && .venv/bin/python -m pytest tests/test_main.py -v` and read `backend/tests/test_main.py`. Note every assertion that references `SPEC_OUT` / `REPO_ROOT/spec.json` / `sources.json` — these must move to the per-session paths below.

- [ ] **Step 2: Make `run()` build a per-session ctx and snapshot the project**

In `backend/main.py`, add imports near the top:

```python
from datetime import datetime
from pipeline import projects as projects_mod
```

Replace the ctx construction + session creation + tail of `run()` (lines ~77-113) so the ctx is per-session and the project folder is written. Concretely:

```python
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    catalog = validate_stage.load_catalog(TEMPLATES_DIR)
    now = datetime.now()
    sid = f"auto-{uuid.uuid4().hex}"
    ctx = executors.EngineContext(
        topic=topic, fps=fps, theme=Theme(), catalog=catalog,
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=ASSETS_DIR / projects_mod.voiceover_name(sid),
        spec_out=projects_mod.project_spec_path(REPO_ROOT, sid),
        sources_out=projects_mod.project_sources_path(REPO_ROOT, sid),
    )
    conn = store.connect(SESSIONS_DB)
    try:
        store.create_session(conn, id=sid, topic=topic, now="autopilot")
        eng = engine.Engine(conn, ctx, session_id=sid)
        emit("session", sid)

        for i, key in enumerate(PIPELINE_STAGES, start=1):
            emit(key, "running")
            _log(f"[{i}/{len(PIPELINE_STAGES)}] {key}...")
            eng.advance(key)
            emit(key, "done")
        eng.materialize_spec()   # writes projects/<sid>/spec.json (ctx.spec_out)

        script_bundle = eng._load_output("script")
        ctx.sources_out.parent.mkdir(parents=True, exist_ok=True)
        ctx.sources_out.write_text(
            json.dumps(build_sources_sidecar(script_bundle["script"]), indent=2),
            encoding="utf-8")
        spec = eng._load_output("assemble")
        projects_mod.write_meta(REPO_ROOT, sid, meta={
            "id": sid,
            "topic": topic,
            "title": spec.meta.title,
            "createdAt": int(now.timestamp() * 1000),
            "durationInFrames": spec.meta.durationInFrames,
            "fps": spec.meta.fps,
        })
        _log(f"      wrote {ctx.spec_out}  ({spec.meta.durationInFrames} frames @ {fps}fps)")
        return spec
    finally:
        conn.close()
```

> The repo-root `SPEC_OUT`/`SOURCES_OUT` writes are gone — `materialize_spec` writes `ctx.spec_out` (now per-session), and sources go to `ctx.sources_out`. `SPEC_OUT`/`SOURCES_OUT` constants stay defined (still referenced by `job_ctx` default + tests); leaving them is harmless.

- [ ] **Step 3: Update `test_main.py` assertions to the per-session paths**

Replace each root-spec assertion. The run returns `spec` and emits `PROGRESS`/the sid; assert the snapshot instead. Add a helper to capture the sid from the emitted session event, or recompute the project dir from `projects/` (newest folder). Concrete replacement pattern:

```python
# after run(...) with a captured sid (from on_stage("session", sid) or the only projects/* dir):
from pipeline import projects as projects_mod
pdir = projects_mod.project_dir(REPO_ROOT, sid)
assert (pdir / "spec.json").exists()
assert (pdir / "sources.json").exists()
assert (pdir / "meta.json").exists()
assert not (REPO_ROOT / "spec.json").exists()   # root spec no longer written by run()
```

> If `test_main.py` patches the stages and asserts spec content, keep those assertions but read from `pdir / "spec.json"` instead of `SPEC_OUT`. Capture `sid` by passing an `on_stage` that records `("session", sid)`.

- [ ] **Step 4: Run the backend test suite**

Run: `cd backend && .venv/bin/python -m pytest tests/test_main.py tests/test_session_autopilot_golden.py -v`
Expected: PASS. (Fix any other test that asserted the root spec — `test_session_autopilot_golden.py` may; retarget it to the project dir the same way.)

- [ ] **Step 5: Smoke the real backend end-to-end**

Run: `cd /home/zain-ali/Documents/AIVideoGenerationTool && backend/.venv/bin/python backend/main.py --topic "two facts about owls" --progress-json`
Expected: a `PROGRESS {"stage":"session","state":"auto-..."}` line; `projects/<sid>/{spec,sources,meta}.json` exist; `remotion/public/assets/voiceover_<sid>.wav` exists; repo-root `spec.json` NOT (re)created by this run.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_main.py backend/tests/test_session_autopilot_golden.py
git commit -m "feat(main): snapshot each run into projects/<sid> with namespaced voiceover"
```

---

## Task 5: Backend — footage gate + edit read/write the session's OWN spec

**Files:**
- Modify: `backend/session_state.py`
- Modify: `backend/session_edit.py:32`
- Test: `backend/tests/test_session_footage_gate.py` (verify still green; update if it pins the global spec)

- [ ] **Step 1: Point `session_state.build_state` at the session's per-session spec**

In `backend/session_state.py`, replace the global read (line 25):

```python
        spec = json.loads(pathlib.Path(job_ctx.SPEC_OUT).read_text(encoding="utf-8"))
```

with the session's own spec path:

```python
        from pipeline import projects as projects_mod
        spec_path = projects_mod.project_spec_path(job_ctx.REPO_ROOT, sid)
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
```

- [ ] **Step 2: Make the edit CLI resume with a per-session ctx**

In `backend/session_edit.py`, `_apply` (line 32) currently builds a global ctx. Pass the sid so the edit re-materializes `projects/<sid>/spec.json` (not the global one):

```python
    ctx = job_ctx.build_ctx(topic=_topic_for(sid), sid=sid)
```

- [ ] **Step 3: Run the footage-gate + edit + provenance tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_footage_gate.py tests/test_session_cli.py tests/test_session_upload_gate.py tests/test_session_provenance.py -v`
Expected: PASS. If a test materialized via a global ctx and then read `SPEC_OUT`, update it to build its ctx with `sid=` and read `projects/<sid>/spec.json` (mirror the Task 4 retarget).

- [ ] **Step 4: Commit**

```bash
git add backend/session_state.py backend/session_edit.py backend/tests/
git commit -m "feat(gate): footage gate state + edits resolve the session's own spec"
```

---

## Task 6: Backend — `store.delete_session` + `session_delete.py` CLI

**Files:**
- Modify: `backend/session/store.py`
- Create: `backend/session_delete.py`
- Test: `backend/tests/test_session_store.py` (add), `backend/tests/test_session_delete.py` (create)

- [ ] **Step 1: Write the failing store test**

Add to `backend/tests/test_session_store.py`:

```python
def test_delete_session_purges_all_tables(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="auto-x", topic="t", now="now")
    store.upsert_stage(conn, "auto-x", "script", status="done", now="now", output_json="{}")
    store.replace_footage_candidates(conn, "auto-x", scene_index=0, candidates=[
        {"rank": 1, "query": "q", "duration_frames": 30, "thumb_url": "u", "selected": 1}])
    store.upsert_provenance(conn, "auto-x", 0, source="auto", query="q", rank=1,
                            pexels_id=1, pexels_url="u")
    store.delete_session(conn, "auto-x")
    assert store.get_session(conn, "auto-x") is None
    assert store.get_stage(conn, "auto-x", "script") is None
    assert store.get_footage_candidates(conn, "auto-x", scene_index=0) == []
    assert store.get_media_provenance(conn, "auto-x") == {}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_store.py -k delete_session -v`
Expected: FAIL — `AttributeError: module 'session.store' has no attribute 'delete_session'`

- [ ] **Step 3: Implement `delete_session`**

Add to `backend/session/store.py`:

```python
def delete_session(conn, session_id) -> None:
    """Remove a session and all its rows (stages, footage candidates, provenance).
    One transaction so a crash can't leave half the session behind. Idempotent."""
    with conn:
        conn.execute("DELETE FROM media_provenance WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM footage_candidates WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM stages WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_store.py -k delete_session -v`
Expected: PASS

- [ ] **Step 5: Write the CLI test**

```python
# backend/tests/test_session_delete.py
import json
import subprocess
import sys
from pathlib import Path

import session_delete


def test_delete_removes_folder_voiceover_and_session(tmp_path, monkeypatch):
    repo = tmp_path
    sid = "auto-del"
    # arrange: project folder + namespaced voiceover in both asset roots + a session row
    (repo / "projects" / sid).mkdir(parents=True)
    (repo / "projects" / sid / "spec.json").write_text("{}")
    for root in ("remotion/public/assets", "preview/public/assets"):
        d = repo / root
        d.mkdir(parents=True)
        (d / f"voiceover_{sid}.wav").write_bytes(b"x")
    from session import store, job_ctx
    monkeypatch.setattr(job_ctx, "REPO_ROOT", repo)
    monkeypatch.setattr(job_ctx, "SESSIONS_DB", repo / "s.db")
    conn = store.connect(job_ctx.SESSIONS_DB)
    store.create_session(conn, id=sid, topic="t", now="now")
    conn.close()

    res = session_delete.delete(sid)

    assert res["ok"] is True
    assert not (repo / "projects" / sid).exists()
    assert not (repo / "remotion/public/assets" / f"voiceover_{sid}.wav").exists()
    assert not (repo / "preview/public/assets" / f"voiceover_{sid}.wav").exists()
    conn = store.connect(job_ctx.SESSIONS_DB)
    assert store.get_session(conn, sid) is None
    conn.close()
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_delete.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'session_delete'`

- [ ] **Step 7: Implement the CLI**

```python
# backend/session_delete.py
"""Delete a project (= session): purge the SQLite session + remove projects/<sid>/
and the namespaced voiceover from both asset roots. Footage is shared/content-
addressed and left in place. Idempotent. Spawned by DELETE /api/projects/[id].

Usage: python backend/session_delete.py --sid <id>
"""
from __future__ import annotations

import sys
import pathlib
import shutil

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from pipeline import projects as projects_mod
from session import store, job_ctx


def delete(sid: str) -> dict:
    repo = job_ctx.REPO_ROOT
    # 1) SQLite session rows
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        store.delete_session(conn, sid)
    finally:
        conn.close()
    # 2) project folder
    shutil.rmtree(projects_mod.project_dir(repo, sid), ignore_errors=True)
    # 3) namespaced voiceover in both asset roots (shared footage stays)
    voiceover = projects_mod.voiceover_name(sid)
    for root in ("remotion/public/assets", "preview/public/assets"):
        p = repo / root / voiceover
        try:
            p.unlink()
        except FileNotFoundError:
            pass
    return {"ok": True, "sid": sid}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(delete(args.sid)))
    except Exception as e:  # fail-loud
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
```

- [ ] **Step 8: Run both delete tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_store.py tests/test_session_delete.py -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/session/store.py backend/session_delete.py backend/tests/test_session_store.py backend/tests/test_session_delete.py
git commit -m "feat(projects): delete_session purge + session_delete CLI"
```

---

## Task 7: Frontend — shared project lib (type + traversal-safe id validation)

**Files:**
- Create: `preview/lib/projects.ts`

- [ ] **Step 1: Write the module**

```typescript
// preview/lib/projects.ts
import path from 'node:path';

export type ProjectMeta = {
  id: string;
  topic: string;
  title: string;
  createdAt: number;
  durationInFrames: number;
  fps: number;
  hasRender: boolean; // derived from projects/<id>/video.mp4 existence
};

// The id is the backend session id (e.g. "auto-<uuid>"). We don't pin its exact
// shape (it may evolve), but we MUST reject anything that could escape the
// projects/ dir when used in a filesystem path. Allow only url/path-safe chars.
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidProjectId(id: string): boolean {
  return ID_RE.test(id);
}

// The preview dev server's cwd is preview/; the repo root is its parent.
export function repoRoot(): string {
  return path.resolve(process.cwd(), '..');
}

export function projectsDir(): string {
  return path.join(repoRoot(), 'projects');
}

export function projectDir(id: string): string {
  return path.join(projectsDir(), id);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add preview/lib/projects.ts
git commit -m "feat(projects-api): shared ProjectMeta type + traversal-safe id validation"
```

---

## Task 8: Frontend — `GET /api/projects` (directory-scan list)

**Files:**
- Create: `preview/app/api/projects/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// preview/app/api/projects/route.ts
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {projectsDir, projectDir, type ProjectMeta} from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const dir = projectsDir();
  const out: ProjectMeta[] = [];
  if (existsSync(dir)) {
    for (const id of readdirSync(dir)) {
      const metaPath = path.join(projectDir(id), 'meta.json');
      if (!existsSync(metaPath)) continue; // skip incomplete/foreign folders
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        out.push({
          ...meta,
          hasRender: existsSync(path.join(projectDir(id), 'video.mp4')),
        });
      } catch {
        // ignore a malformed meta.json — never let one bad folder break the list
      }
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt); // newest first
  return Response.json(out);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify against the project from the Task 4 smoke run**

With the dev server up (Task 13 startup): `curl -s localhost:3100/api/projects | head -c 400`
Expected: a JSON array containing the owls project with `"hasRender": false`.

- [ ] **Step 4: Commit**

```bash
git add preview/app/api/projects/route.ts
git commit -m "feat(projects-api): GET /api/projects directory-scan list"
```

---

## Task 9: Frontend — `GET`/`DELETE /api/projects/[id]`

**Files:**
- Create: `preview/app/api/projects/[id]/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// preview/app/api/projects/[id]/route.ts
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {isValidProjectId, projectDir} from '@/lib/projects';
import {spawnJson} from '../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bad = (status: number, error: string) =>
  new Response(JSON.stringify({error}), {status, headers: {'content-type': 'application/json'}});

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return bad(400, 'Invalid project id');
  const specPath = path.join(projectDir(id), 'spec.json');
  if (!existsSync(specPath)) return bad(404, 'Project not found');
  const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
  const sourcesPath = path.join(projectDir(id), 'sources.json');
  const sources = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf-8')) : null;
  return Response.json({spec, sources});
}

export async function DELETE(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return bad(400, 'Invalid project id');
  // All sqlite + filesystem teardown lives in Python (single owner of the DB).
  const {code, json} = await spawnJson('session_delete.py', ['--sid', id]);
  if (code !== 0 || json?.ok === false) {
    return bad(500, json?.error ?? 'delete failed');
  }
  return Response.json({ok: true});
}
```

> Confirm the `_spawn` import path. The state route imports it as `'../../../_spawn'` from `app/api/session/[id]/state/route.ts`; from `app/api/projects/[id]/route.ts` the depth to `app/api/_spawn` is `'../../_spawn'`. Adjust if `_spawn` lives elsewhere (check `preview/app/api/_spawn.ts` first).

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify GET + DELETE against a throwaway project**

```bash
SID=$(curl -s localhost:3100/api/projects | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
curl -s "localhost:3100/api/projects/$SID" | head -c 120   # {"spec":{...},"sources":{...}}
```
(Defer an actual DELETE to the Task 13 eyes-on gate so a real project survives for it.)

- [ ] **Step 4: Commit**

```bash
git add "preview/app/api/projects/[id]/route.ts"
git commit -m "feat(projects-api): GET spec+sources; DELETE project (spawns session_delete)"
```

---

## Task 10: Frontend — `GET /api/projects/[id]/video` (range-aware MP4 stream)

**Files:**
- Create: `preview/app/api/projects/[id]/video/route.ts`

This mirrors the existing `preview/app/api/render/output/route.ts` (same `parseRange`/`toResponseBody`) but resolves the path per project.

- [ ] **Step 1: Write the route**

```typescript
// preview/app/api/projects/[id]/video/route.ts
import {createReadStream, statSync, existsSync} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {isValidProjectId, projectDir} from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRange(range: string, size: number): {start: number; end: number} | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start: number;
  let end: number;
  if (s === '') {
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Number(e);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return {start, end: Math.min(end, size - 1)};
}

function toResponseBody(stream: ReturnType<typeof createReadStream>, signal: AbortSignal) {
  stream.on('error', () => stream.destroy());
  if (signal.aborted) stream.destroy();
  else signal.addEventListener('abort', () => stream.destroy(), {once: true});
  return Readable.toWeb(stream) as ReadableStream;
}

export async function GET(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return new Response('Invalid id', {status: 400});
  const file = path.join(projectDir(id), 'video.mp4');
  if (!existsSync(file)) return new Response('Not rendered', {status: 404});

  const size = statSync(file).size;
  const rangeHeader = req.headers.get('range');
  const base = {'content-type': 'video/mp4', 'accept-ranges': 'bytes'};

  if (rangeHeader) {
    const r = parseRange(rangeHeader, size);
    if (!r) {
      return new Response('Invalid range', {status: 416, headers: {'content-range': `bytes */${size}`}});
    }
    const stream = createReadStream(file, {start: r.start, end: r.end});
    return new Response(toResponseBody(stream, req.signal), {
      status: 206,
      headers: {
        ...base,
        'content-range': `bytes ${r.start}-${r.end}/${size}`,
        'content-length': String(r.end - r.start + 1),
      },
    });
  }

  const stream = createReadStream(file);
  return new Response(toResponseBody(stream, req.signal), {
    status: 200,
    headers: {...base, 'content-length': String(size)},
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "preview/app/api/projects/[id]/video/route.ts"
git commit -m "feat(projects-api): GET /api/projects/[id]/video range stream"
```

---

## Task 11: Frontend — render-by-id + generate done-event cleanup

**Files:**
- Modify: `preview/app/api/render/route.ts`
- Modify: `preview/app/api/generate/route.ts`

- [ ] **Step 1: Render the selected project by id**

In `preview/app/api/render/route.ts`, change `POST()` to read an `id` from the body and stage that project's spec. Replace the signature + the early single-flight + the spawn:

```typescript
import {copyFileSync, mkdirSync} from 'node:fs';
// ...existing imports (spawn, path)...

export async function POST(req: Request) {
  let id = '';
  try {
    const body = await req.json();
    id = typeof body?.id === 'string' ? body.id.trim() : '';
  } catch {
    id = '';
  }
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return new Response(JSON.stringify({error: 'A valid project "id" is required to render.'}), {
      status: 400, headers: {'content-type': 'application/json'},
    });
  }
  if (rendering) {
    // ...existing 409 unchanged...
  }
  // ...existing rendering=true, encoder, killChild, teardown unchanged...
```

Change the `spawn('npm', ['run', 'render'], {...})` to pass `SPEC_PATH` so `copy-spec.mjs` stages this project's spec:

```typescript
      child = spawn('npm', ['run', 'render'], {
        cwd: REMOTION_DIR,
        env: {...process.env, SPEC_PATH: `projects/${id}/spec.json`},
        shell: false,
        detached: true,
      });
```

- [ ] **Step 2: Archive the MP4 into the project on success**

Replace the `child.on('close', ...)` success branch:

```typescript
      child.on('close', (code) => {
        if (code === 0) {
          try {
            const src = path.resolve(REMOTION_DIR, 'out', 'video.mp4');
            const destDir = path.resolve(REMOTION_DIR, '..', 'projects', id);
            mkdirSync(destDir, {recursive: true});
            copyFileSync(src, path.join(destDir, 'video.mp4'));
          } catch (e) {
            send({type: 'error', message: `Render saved but archiving failed: ${(e as Error).message}`});
            finish();
            return;
          }
          send({type: 'done', id, output: `/api/projects/${id}/video`});
        } else {
          send({type: 'error', message: `Render exited with code ${code}`});
        }
        finish();
      });
```

> `out/video.mp4` is still the single render slot (single-flight `rendering` guard already serializes). We copy it into the project immediately on success, so the next render can reuse the slot.

- [ ] **Step 3: Drop the dead spec field from the generate `done` event**

In `preview/app/api/generate/route.ts`, the success branch currently sends `{type: 'done', spec: '/spec.json', sid}`. Remove the now-unused `spec` field (the client loads the spec via `/api/projects/<sid>`):

```typescript
          await stageAssets();
          send({type: 'done', sid});
```

- [ ] **Step 4: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add preview/app/api/render/route.ts preview/app/api/generate/route.ts
git commit -m "feat(api): render a project by id (SPEC_PATH + archive); generate done drops dead spec field"
```

---

## Task 12: Frontend — drop the dead root-spec copy; UI project library

**Files:**
- Modify: `preview/scripts/copy-assets.mjs`
- Rewrite: `preview/components/HistoryList.tsx`
- Modify: `preview/components/RenderControls.tsx`
- Modify: `preview/components/Studio.tsx`

- [ ] **Step 1: Remove the spec-copy block from `copy-assets`**

In `preview/scripts/copy-assets.mjs`, delete the `override`/`specCandidates`/`copyFileSync(srcSpec, dstSpec)` block (lines ~26-35). Keep the assets-mirror block. The Player no longer reads `preview/public/spec.json`.

Verify: `cd preview && npm run copy-assets` → `[copy-assets] assets -> ...` with no spec line, no error.

- [ ] **Step 2: Rewrite `HistoryList.tsx` as a project list**

```tsx
'use client';

import {Eyebrow} from './ui';
import type {ProjectMeta} from '@/lib/projects';

function fmtDuration(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(1)}s`;
}

function fmtAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function ProjectList({
  projects,
  selectedId,
  onOpen,
  onDelete,
}: {
  projects: ProjectMeta[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>Library</Eyebrow>
      {projects.length === 0 ? (
        <p className="mt-3 font-ui text-[13px] text-ink-muted">
          No videos yet — generate one to get started.
        </p>
      ) : (
        <div className="mt-3 flex flex-col">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-150 hover:bg-white/[0.04] ${
                p.id === selectedId ? 'bg-white/[0.06]' : ''
              }`}
            >
              <button onClick={() => onOpen(p.id)} className="min-w-0 text-left">
                <div className="truncate font-ui text-[13.5px] font-medium text-ink">{p.title}</div>
                <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                  {fmtDuration(p.durationInFrames, p.fps)} · {fmtAgo(p.createdAt)}
                  {p.hasRender ? ' · rendered' : ''}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-3">
                {p.hasRender && (
                  <a
                    href={`/api/projects/${p.id}/video`}
                    download="video.mp4"
                    className="font-ui text-[12px] text-accent-3 transition-opacity hover:opacity-80"
                  >
                    ↓ MP4
                  </a>
                )}
                <button
                  onClick={() => onDelete(p.id)}
                  className="font-ui text-[12px] text-ink-muted transition-colors hover:text-ink"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Point `RenderControls` at the selected project id**

In `preview/components/RenderControls.tsx`: remove the `RenderRecord` type + `onComplete` prop; add `projectId: string` + `onRendered: () => void`. Send the id in the POST body and call `onRendered()` on the `done` branch:

```tsx
export function RenderControls({
  spec,
  projectId,
  onRendered,
}: {
  spec: Spec;
  projectId: string;
  onRendered: () => void;
}) {
  // ...existing state unchanged...

  async function render() {
    // ...existing setup unchanged...
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({id: projectId}),
    });
    // ...existing stream reading unchanged...
    // in the `done` branch: use msg.output for the inline preview URL, then:
    onRendered();
  }
```

> Keep the inline rendered-preview using `msg.output` (now `/api/projects/<id>/video`).

- [ ] **Step 4: Make `Studio` server-backed (list + open + gate-on-open + empty state)**

Edit `preview/components/Studio.tsx`:

(a) Imports — swap `HistoryList`/`RenderRecord` for the project list + type:

```tsx
import {RenderControls} from './RenderControls';
import {ProjectList} from './HistoryList';
import type {ProjectMeta} from '@/lib/projects';
```

(b) State — replace `failed`/`history` with the project list + selection (keep `spec`, `sessionId`, `gateScenes`, `editing`, `stages`, `generating`, `genNonce`):

```tsx
  const [spec, setSpec] = useState<Spec | null>(null);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stages, setStages] = useState<Stage[]>(freshStages);
  const [generating, setGenerating] = useState(false);
  const [genNonce, setGenNonce] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [gateScenes, setGateScenes] = useState<GateScene[]>([]);
  const [editing, setEditing] = useState(false);
```

(c) Replace the mount effect (the `fetch('/spec.json')` one) with list-load + helpers. `openProject` loads BOTH the spec (into the Player) AND the footage-gate state (so the gate works for re-opened projects), and sets `sessionId` so edits target the right session:

```tsx
  async function refreshProjects(): Promise<ProjectMeta[]> {
    const r = await fetch('/api/projects');
    const list: ProjectMeta[] = r.ok ? await r.json() : [];
    setProjects(list);
    return list;
  }

  async function openProject(id: string) {
    const r = await fetch(`/api/projects/${id}?t=${Date.now()}`);
    if (!r.ok) return;
    const {spec: s} = (await r.json()) as {spec: Spec};
    setSpec(s);
    setSelectedId(id);
    setSessionId(id);            // edits + gate target this session
    setGenNonce((n) => n + 1);
    try {
      const st = await fetch(`/api/session/${id}/state`).then((x) => x.json());
      setGateScenes(Array.isArray(st?.scenes) ? st.scenes : []);
    } catch {
      setGateScenes([]);
    }
  }

  async function deleteProject(id: string) {
    await fetch(`/api/projects/${id}`, {method: 'DELETE'});
    const list = await refreshProjects();
    if (id === selectedId) {
      if (list[0]) await openProject(list[0].id);
      else {
        setSpec(null);
        setSelectedId(null);
        setSessionId(null);
        setGateScenes([]);
      }
    }
  }

  useEffect(() => {
    refreshProjects().then((list) => {
      if (list[0]) openProject(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

(d) In `generate(...)`, replace the `done` branch body so it refreshes the list and opens the new project (which also loads its gate). Remove the old `/spec.json` fetch + `setFailed`:

```tsx
          } else if (msg.type === 'done') {
            finished = true;
            const sid = typeof msg.sid === 'string' ? msg.sid : null;
            const list = await refreshProjects();
            if (sid) await openProject(sid);
            const title = list.find((p) => p.id === sid)?.title ?? 'Untitled';
            toast.success('Video generated', {id: toastId, description: title});
          } else if (msg.type === 'error') {
```

(e) In `pick(...)` and `refreshAfterEdit(...)`, replace the `fetch('/spec.json?t=...')` reload with the selected project's spec:

```tsx
      // pick(): after re-highlighting from the edit response —
      const r = await fetch(`/api/projects/${sessionId}?t=${Date.now()}`);
      setSpec((await r.json()).spec);
      setGenNonce((n) => n + 1);
```

```tsx
  async function refreshAfterEdit(sid: string) {
    try {
      const st = await fetch(`/api/session/${sid}/state`).then((x) => x.json());
      if (Array.isArray(st?.scenes)) setGateScenes(st.scenes);
    } catch {
      /* keep the prior gate on a transient state error */
    }
    const r = await fetch(`/api/projects/${sid}?t=${Date.now()}`);
    setSpec((await r.json()).spec);
    setGenNonce((n) => n + 1);
  }
```

(f) JSX — replace the `RenderControls` block to pass `projectId`/`onRendered`, and the `HistoryList` block with `ProjectList`. Replace the Player's `failed` branch with the empty-library state:

```tsx
          {spec && selectedId && (
            <motion.div {...rise} transition={{...rise.transition, delay: 0.12}}>
              <RenderControls spec={spec} projectId={selectedId} onRendered={refreshProjects} />
            </motion.div>
          )}

          {/* FootageGate block unchanged — still keyed on sessionId + gateScenes */}

          <motion.div {...rise} transition={{...rise.transition, delay: 0.16}}>
            <ProjectList
              projects={projects}
              selectedId={selectedId}
              onOpen={openProject}
              onDelete={deleteProject}
            />
          </motion.div>
```

```tsx
            <div className="overflow-hidden rounded-[var(--radius-md)] bg-black">
              {spec ? (
                <PlayerClient key={genNonce} spec={spec} />
              ) : (
                <div className="flex aspect-[1080/1920] items-center justify-center p-6 text-center font-ui text-[13px] text-ink-muted">
                  No videos yet — generate one to get started.
                </div>
              )}
            </div>
```

> Remove the now-unused `failed` state, its `setFailed` calls, and the `RenderRecord` import.

- [ ] **Step 5: Typecheck**

Run: `cd preview && npm run typecheck`
Expected: no errors. (Fix any lingering `RenderRecord` / `HistoryList` / `failed` references.)

- [ ] **Step 6: Commit**

```bash
git add preview/scripts/copy-assets.mjs preview/components/Studio.tsx preview/components/HistoryList.tsx preview/components/RenderControls.tsx
git commit -m "feat(ui): server-backed project library — open (spec+gate), render, download, delete"
```

---

## Task 13: End-to-end visual gate (eyes-on before merge)

**Files:** none (verification only). Per the project's working rhythm, written checks aren't enough — confirm on real frames before the PR.

- [ ] **Step 1: Start the dev server**

Run: `cd preview && PORT=3100 npm run dev` (background it; predev runs build-registry + copy-assets).

- [ ] **Step 2: Generate two distinct videos**

In the browser at `localhost:3100`: generate topic A, wait for completion; generate topic B. Confirm both appear in the Library (newest first, B selected and previewing).

- [ ] **Step 3: Footage gate on the freshly generated project**

With B selected, do one footage edit (pick a different candidate, or re-query a scene). Confirm the Player updates and the gate re-highlights.

- [ ] **Step 4: Render the selected project**

Click Render; wait for completion. Confirm the row shows "rendered" and ↓ MP4 downloads a playable file from `/api/projects/<id>/video`.

- [ ] **Step 5: The persistence proof**

Hard-refresh. Confirm: both projects still listed; the selected one re-previews **pixel-perfect** (same hero frame); the rendered MP4 still downloads. Navigate to `/templates` and back — list still present.

- [ ] **Step 6: Re-open an OLD project and edit its footage (the unify proof)**

Open project A (older). Confirm its spec previews AND its footage gate populates (scenes/candidates from A's session). Do one pick on A; confirm A's Player updates — proving the gate re-binds to the opened session, not B.

- [ ] **Step 7: Re-render the old project**

With A open, click Render; confirm it produces A's MP4 (play the downloaded file to verify it's A, not B).

- [ ] **Step 8: Delete**

Delete project A. Confirm it disappears, B remains selected/previewing, and on disk: `projects/<A-sid>/` gone, `remotion/public/assets/voiceover_<A-sid>.wav` gone, and A's SQLite row gone:

```bash
ls projects/ ; ls remotion/public/assets/ | grep "<A-sid>" || echo "voiceover gone"
backend/.venv/bin/python -c "import sys;sys.path.insert(0,'backend');from session import store,job_ctx;c=store.connect(job_ctx.SESSIONS_DB);print('row:', store.get_session(c,'<A-sid>'))"
# Expected: voiceover gone; row: None
```

- [ ] **Step 9: Paste hero frames + finish the branch**

Capture the re-preview hero frame after refresh (Step 5) and the rendered-MP4 first frame (Step 7). Once they read correctly, use `superpowers:finishing-a-development-branch` to open the PR **into development** (never master).

---

## Self-Review notes (author)

- **Spec coverage** (against `2026-06-08-project-library-design.md`):
  - Decision 1 (backend mints id): satisfied by reusing the existing `sid` (no parallel mint) — T4.
  - Decision 2 (pixel-perfect ⇒ namespaced voiceover): T2 + T3 + T4 (`voiceover_<sid>.wav`).
  - Decision 3 (re-render in scope): T11 (render-by-id, SPEC_PATH staging).
  - Decision 4 (directory scan, no global index): T8 (`meta.json` sidecar + scan). SQLite holds stage/edit state, not the list — distinct data, one writer each, keyed by the same sid.
  - Decision 5 (served via API, not mirrored into public): T8/T9/T10 routes; `projects/` never mirrored.
  - Decision 6 (no root spec.json as truth): T4 stops writing it; T12 drops the copy-assets spec block; Player loads the selected project via `/api/projects/<sid>` (T12).
  - Decision 7 (manual delete): T6 + T9 + T12 (also purges the SQLite session — beyond the old plan, required by the spine).
  - Error handling (missing `projects/`, malformed `meta.json`, idempotent delete, single-flight render/generate): T8 (scan guards), T6 (idempotent delete), existing flags unchanged.
  - **Unify-specific win not in the old spec:** re-opening an old project re-binds its footage gate (T5 + T12 `openProject`) — verified in T13 S6.
- **Placeholder scan:** none — every code step shows real content. Two reads-before-edit (T4 S1 `test_main.py`, T9 S1 `_spawn` path) are verification steps, not placeholders; both give the exact replacement.
- **Type consistency:** `ProjectMeta` (T7) is consumed unchanged by T8/T12; `voiceover_name(sid)` (T1) used identically in T2/T4/T6; `isValidProjectId`/`ID_RE` shared T7→T9/T10; render body `{id}` (T11) matches `RenderControls` POST (T12 S3).
- **Deferred (unchanged from old spec):** footage GC, keep-last-N retention, incremental copy-assets mirror, human-readable ids (sid stays `auto-<uuid>`; the library shows `meta.title`).
- **Pre-flight (do before Task 1):** branch `phase-5-project-library` off the post-A.6-merge `development`. Confirm `development` contains the A.6.2/6.3/6.4 surface (`backend/session_edit.py` `--op` choices include `re_query`/`upload`; `preview/app/api/session/[id]/edit/route.ts` handles multipart) — else the gate-edit reconciliation in T5 is incomplete.
```