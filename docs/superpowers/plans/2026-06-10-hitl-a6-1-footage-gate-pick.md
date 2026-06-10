# HITL A.6.1 — Footage-gate Pick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the persisted session in the preview so a user can pick a different clip from a footage scene's candidate pool and see the in-browser Player update.

**Architecture:** New thin Python CLI entrypoints (`session_state.py`, `session_edit.py`) resume the already-persisted session by id and do one operation — matching the existing `/api/generate`→`main.py` spawn pattern. New Next.js routes (`GET .../state`, `POST .../edit`) spawn them. `main.run` emits its session id; the generate route surfaces it; the Studio renders a footage-gate panel (pool thumbnails → click-to-pick) and reloads `spec.json` into the live Player on each pick. No MP4 auto-render.

**Tech Stack:** Python 3.12 + pytest (backend, TDD); Next.js 15 App-Router route handlers + React (preview, verified by typecheck + curl + eyes-on — the preview app has no JS test harness, and adding one is out of scope for A.6.1).

**Spec:** `docs/superpowers/specs/2026-06-10-hitl-a6-1-footage-gate-pick-design.md`

---

## File Structure

- **Modify** `backend/main.py` — `run()` emits `("session", <sid>)` via the existing `emit` callback (only autopilot change).
- **Create** `backend/session/job_ctx.py` — lightweight `build_ctx(topic, fps)` + REPO_ROOT-relative path constants the CLIs need (mirrors main.py's paths; no `tts`/heavy import, so a state read stays fast).
- **Create** `backend/session_state.py` — read-only `build_state(sid) -> dict` + `__main__` CLI (`--sid`).
- **Create** `backend/session_edit.py` — `apply_pick(sid, scene, rank) -> dict` + `__main__` CLI (`--sid --op pick --scene --rank`).
- **Create** `backend/tests/test_session_cli.py` — pytest for `build_state` + `apply_pick`.
- **Create** `preview/app/api/_spawn.ts` — shared `spawnJson(scriptArgs)` helper (spawn a Python CLI, collect stdout, parse one JSON line).
- **Create** `preview/app/api/session/[id]/state/route.ts` — `GET` → `spawnJson(session_state)`.
- **Create** `preview/app/api/session/[id]/edit/route.ts` — `POST` → single-flight → `spawnJson(session_edit)` → `copy-assets` → return verbatim.
- **Modify** `preview/app/api/generate/route.ts` — capture the `session` PROGRESS line; add `sid` to the `done` event.
- **Create** `preview/components/FootageGate.tsx` — per-footage-scene pool thumbnail grid → `onPick(scene, rank)`.
- **Modify** `preview/components/Studio.tsx` — capture `sid`, fetch `/state`, render `FootageGate`, wire `onPick` (POST edit → update highlight + reload Player + stale toast).

---

## Task 1: `main.run` emits the session id

**Files:**
- Modify: `backend/main.py:93` (right after `eng = engine.Engine(...)`)
- Test: `backend/tests/test_session_cli.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_cli.py` with this first test (it reuses the autopilot-golden seed pattern — faked stages, offline):

```python
"""HITL A.6.1 — session CLI entrypoints (state read + pick edit) and the sid emit."""
import json
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming
from pipeline import validate as validate_stage
from session import store, executors, engine


def _seed_session(tmp_path, monkeypatch, *, sid="s-cli"):
    """A real cold session via the engine with faked upstream stages (offline).
    Footage scene is beat index 1 ('mid', keyword 'coral reef')."""
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

    catalog = validate_stage.load_catalog(Path(__file__).resolve().parents[2] / "templates")
    ctx = executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog, assets_dir=tmp_path / "a",
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id=sid, topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id=sid)
    eng.run_all()
    return conn, ctx, sid


def test_run_emits_session_id(tmp_path, monkeypatch):
    import main as m
    # fake the stages main.run drives (same shapes as the seed) + redirect output paths
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script", lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1))
                                              for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])
    pool = {"coral reef": [{"duration": 6, "video_files": [{"link": "f.mp4", "width": 1080,
            "height": 1920, "file_type": "video/mp4"}], "video_pictures": [{"picture": "t"}]}]}
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pool.get(q, [])})
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")
    monkeypatch.setattr(m, "ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr(m, "SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr(m, "SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr(m, "SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr(m, "RETRIEVAL_CACHE", tmp_path / "c")

    events = []
    m.run("Reefs", on_stage=lambda key, state: events.append((key, state)))
    sid_events = [v for (k, v) in events if k == "session"]
    assert len(sid_events) == 1
    assert sid_events[0].startswith("auto-")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_run_emits_session_id -v`
Expected: FAIL — no `("session", …)` event is emitted yet (`sid_events` is empty).

- [ ] **Step 3: Emit the sid**

In `backend/main.py`, immediately after line 93 (`eng = engine.Engine(conn, ctx, session_id=sid)`), add:

```python
        emit("session", sid)   # A.6: surface the session id so the preview can resume + edit it
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_run_emits_session_id -v`
Expected: PASS

- [ ] **Step 5: Run the autopilot golden (byte-identity invariant)**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_autopilot_golden.py tests/test_main.py -q`
Expected: all green (emitting an extra progress event doesn't touch spec.json).

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/tests/test_session_cli.py
git commit -m "feat(a6.1): main.run emits session id via the progress callback"
```

---

## Task 2: `job_ctx.build_ctx` — lightweight EngineContext for the CLIs

**Files:**
- Create: `backend/session/job_ctx.py`
- Test: `backend/tests/test_session_cli.py`

This mirrors main.py's REPO_ROOT-relative paths so the CLIs write `spec.json` exactly where the preview reads it, WITHOUT importing main.py (which pulls the heavy `tts` module — a state read must stay fast). The duplication is deliberate; a future cleanup can unify (out of scope).

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_session_cli.py`:

```python
def test_job_ctx_paths_match_main():
    import main as m
    from session import job_ctx
    ctx = job_ctx.build_ctx(topic="X", fps=30)
    assert ctx.spec_out == m.SPEC_OUT
    assert ctx.assets_dir == m.ASSETS_DIR
    assert ctx.sources_out == m.SOURCES_OUT
    assert ctx.cache_dir == m.RETRIEVAL_CACHE
    assert ctx.topic == "X" and ctx.fps == 30
    assert ctx.catalog  # templates loaded
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_job_ctx_paths_match_main -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'session.job_ctx'`.

- [ ] **Step 3: Write the module**

Create `backend/session/job_ctx.py`:

```python
"""A.6 — lightweight EngineContext builder for the session CLI entrypoints.

Mirrors main.py's REPO_ROOT-relative paths so a resumed session writes spec.json
exactly where the preview reads it. Deliberately imports only the cheap modules
(no pipeline.tts / torch) so a state read / pick edit starts fast.
"""
from __future__ import annotations

from pathlib import Path

from schema import Theme
from pipeline import validate as validate_stage
from session.executors import EngineContext

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_DIR = REPO_ROOT / "remotion" / "public" / "assets"
TEMPLATES_DIR = REPO_ROOT / "templates"
SPEC_OUT = REPO_ROOT / "spec.json"
SOURCES_OUT = REPO_ROOT / "sources.json"
RETRIEVAL_CACHE = REPO_ROOT / ".cache" / "retrieval"
SESSIONS_DB = REPO_ROOT / "backend" / ".sessions" / "sessions.db"


def build_ctx(*, topic: str, fps: int = 30) -> EngineContext:
    return EngineContext(
        topic=topic, fps=fps, theme=Theme(),
        catalog=validate_stage.load_catalog(TEMPLATES_DIR),
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=ASSETS_DIR / "voiceover.wav",
        spec_out=SPEC_OUT, sources_out=SOURCES_OUT)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_job_ctx_paths_match_main -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/session/job_ctx.py backend/tests/test_session_cli.py
git commit -m "feat(a6.1): job_ctx — lightweight EngineContext builder for session CLIs"
```

---

## Task 3: `session_state.py` — read-only session state

**Files:**
- Create: `backend/session_state.py`
- Test: `backend/tests/test_session_cli.py`

Reads the persisted DB + materialized `spec.json` (no engine/ctx needed) and emits the per-scene pool + provenance.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_session_cli.py`:

```python
def test_build_state_shape(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    conn.close()
    import session_state as ss
    # point the CLI at the seed's DB + spec via monkeypatched job_ctx constants
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    state = ss.build_state(sid)

    assert state["sid"] == sid
    scenes = state["scenes"]
    # footage scene (index 1) has a non-empty candidate pool with the documented fields
    foot = next(s for s in scenes if s["needsFootage"])
    assert foot["index"] == 1
    cand = foot["candidates"]
    assert cand and {"rank", "thumbUrl", "durationFrames", "selected"} <= cand[0].keys()
    assert any(c["selected"] for c in cand)           # exactly the auto pick is selected
    assert foot["provenance"]["source"] == "auto"
    # a non-footage scene reports needsFootage False + empty pool
    nonfoot = next(s for s in scenes if not s["needsFootage"])
    assert nonfoot["candidates"] == []


def test_build_state_bad_sid_raises(tmp_path, monkeypatch):
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    import session_state as ss
    import pytest
    # empty db (no such session) → KeyError
    with pytest.raises(KeyError):
        ss.build_state("nope")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_build_state_shape tests/test_session_cli.py::test_build_state_bad_sid_raises -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'session_state'`.

- [ ] **Step 3: Write the entrypoint**

Create `backend/session_state.py`:

```python
"""A.6.1 — read-only session state for the preview footage gate.

Resolves the persisted session's per-scene candidate pool + provenance. Pure read:
opens the DB, reads the materialized spec.json for the scene list, joins the footage
candidate pool + media provenance. Prints one JSON line; never mutates.

Usage: python backend/session_state.py --sid <id>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import store, job_ctx


def build_state(sid: str) -> dict:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        if store.get_session(conn, sid) is None:
            raise KeyError(f"no session {sid!r}")
        spec = json.loads(pathlib.Path(job_ctx.SPEC_OUT).read_text(encoding="utf-8"))
        prov = store.get_media_provenance(conn, sid)
        scenes = []
        for i, sc in enumerate(spec.get("scenes", [])):
            media = (sc.get("templateProps") or {}).get("media")
            needs_footage = media is not None
            candidates = []
            if needs_footage:
                for r in store.get_footage_candidates(conn, sid, scene_index=i):
                    candidates.append({
                        "rank": r["rank"], "thumbUrl": r["thumb_url"],
                        "durationFrames": r["duration_frames"], "selected": bool(r["selected"])})
            p = prov.get(i)
            scenes.append({
                "index": i, "template": sc.get("template"), "needsFootage": needs_footage,
                "candidates": candidates,
                "provenance": (None if p is None else {
                    "source": p["source"], "query": p["query"], "rank": p["rank"],
                    "pexelsId": p["pexels_id"], "pexelsUrl": p["pexels_url"]})})
        return {"sid": sid, "scenes": scenes}
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(build_state(args.sid)))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_build_state_shape tests/test_session_cli.py::test_build_state_bad_sid_raises -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/session_state.py backend/tests/test_session_cli.py
git commit -m "feat(a6.1): session_state.py — read-only per-scene pool + provenance"
```

---

## Task 4: `session_edit.py` — apply a footage pick

**Files:**
- Create: `backend/session_edit.py`
- Test: `backend/tests/test_session_cli.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_session_cli.py`:

```python
def test_apply_pick_rebinds_and_returns_selection(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    media0 = spec0["scenes"][1]["templateProps"]["media"]["src"]
    conn.close()

    # point the CLI's ctx + db at the seed (build_ctx reads job_ctx constants)
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")

    import session_edit as se
    res = se.apply_pick(sid, scene=1, rank=2)

    assert res["ok"] is True and res["scene"] == 1 and res["selectedRank"] == 2
    assert res["provenance"]["source"] == "pick" and res["provenance"]["rank"] == 2
    spec1 = json.loads((tmp_path / "spec.json").read_text())
    media1 = spec1["scenes"][1]["templateProps"]["media"]["src"]
    assert media1 != media0 and "_2." in media1   # rank-2 clip bound + spec re-materialized
    # timing unchanged (footage edit invariant)
    t0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]
    t1 = [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]]
    assert t0 == t1


def test_apply_pick_fails_loud(tmp_path, monkeypatch):
    conn, ctx, sid = _seed_session(tmp_path, monkeypatch)
    conn.close()
    monkeypatch.setattr("session.job_ctx.SESSIONS_DB", tmp_path / "s.db")
    monkeypatch.setattr("session.job_ctx.SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr("session.job_ctx.ASSETS_DIR", tmp_path / "a")
    monkeypatch.setattr("session.job_ctx.SOURCES_OUT", tmp_path / "src.json")
    monkeypatch.setattr("session.job_ctx.RETRIEVAL_CACHE", tmp_path / "c")
    import session_edit as se
    import pytest
    with pytest.raises(Exception):          # unknown rank → engine raises
        se.apply_pick(sid, scene=1, rank=99)
    with pytest.raises(KeyError):           # bad sid → resume raises
        se.apply_pick("nope", scene=1, rank=1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py::test_apply_pick_rebinds_and_returns_selection tests/test_session_cli.py::test_apply_pick_fails_loud -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'session_edit'`.

- [ ] **Step 3: Write the entrypoint**

Create `backend/session_edit.py`:

```python
"""A.6.1 — apply one footage edit to a persisted session and re-materialize spec.json.

A.6.1 accepts only op="pick" (offline/deterministic: binds the stored-pool clip the
user was shown). resume → api.edit (invalidate + re-derive assemble + materialize
spec.json) → return the post-edit scene state so the UI re-highlights from the
response. Fail-loud: bad sid → KeyError; non-footage / unknown rank → the engine raises.

Usage: python backend/session_edit.py --sid <id> --op pick --scene <n> --rank <r>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
from session import api, store, job_ctx


def apply_pick(sid: str, *, scene: int, rank: int) -> dict:
    ctx = job_ctx.build_ctx(topic=_topic_for(sid))
    sess = api.resume(job_ctx.SESSIONS_DB, ctx, session_id=sid)   # KeyError if no such session
    try:
        api.edit(sess, "footage", {"op": "pick", "scene_index": scene, "rank": rank})
        prov = api.media_provenance(sess).get(scene)
        return {"ok": True, "sid": sid, "scene": scene, "selectedRank": rank,
                "provenance": (None if prov is None else {
                    "source": prov["source"], "query": prov["query"], "rank": prov["rank"],
                    "pexelsId": prov["pexels_id"], "pexelsUrl": prov["pexels_url"]})}
    finally:
        api.close(sess)


def _topic_for(sid: str) -> str:
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        return row["topic"]
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--op", required=True, choices=["pick"])  # re_query/upload arrive in A.6.2/A.6.3
    ap.add_argument("--scene", type=int, required=True)
    ap.add_argument("--rank", type=int, required=True)
    args = ap.parse_args()
    try:
        print(json.dumps(apply_pick(args.sid, scene=args.scene, rank=args.rank)))
    except Exception as e:  # fail-loud: non-zero exit + error JSON on stdout
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_cli.py -v`
Expected: all green (the whole CLI test file).

- [ ] **Step 5: Commit**

```bash
git add backend/session_edit.py backend/tests/test_session_cli.py
git commit -m "feat(a6.1): session_edit.py — apply footage pick, return post-edit selection"
```

---

## Task 5: Shared `spawnJson` route helper

**Files:**
- Create: `preview/app/api/_spawn.ts`

No JS test harness in the preview app; verify by typecheck (Task 11) + curl (Task 7).

- [ ] **Step 1: Write the helper**

Create `preview/app/api/_spawn.ts`:

```typescript
import {spawn} from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(process.cwd(), '..');
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');

// Spawn a backend Python CLI that prints exactly one JSON line on stdout, and resolve
// it. Matches the /api/generate spawn pattern (cwd = repo root so .env + paths resolve).
// Rejects on spawn error, non-zero exit, or unparseable stdout.
export function spawnJson(
  scriptRelToBackend: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{code: number; json: any}> {
  return new Promise((resolve, reject) => {
    const script = path.join(REPO_ROOT, 'backend', scriptRelToBackend);
    const child = spawn(PYTHON, [script, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
      shell: false,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${scriptRelToBackend} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err = (err + b.toString()).slice(-2000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '';
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        reject(new Error(`${scriptRelToBackend} bad output (exit ${code}): ${err.slice(-300)}`));
        return;
      }
      resolve({code: code ?? 0, json});
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add preview/app/api/_spawn.ts
git commit -m "feat(a6.1): spawnJson helper for spawning backend session CLIs"
```

---

## Task 6: `GET /api/session/[id]/state` route

**Files:**
- Create: `preview/app/api/session/[id]/state/route.ts`

- [ ] **Step 1: Write the route**

Create `preview/app/api/session/[id]/state/route.ts`:

```typescript
import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  try {
    const {code, json} = await spawnJson('session_state.py', ['--sid', id]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'session not found'}, {status: 404});
    }
    return Response.json(json);
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'state failed'}, {status: 500});
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add preview/app/api/session
git commit -m "feat(a6.1): GET /api/session/[id]/state route"
```

---

## Task 7: `POST /api/session/[id]/edit` route (single-flight + copy-assets)

**Files:**
- Create: `preview/app/api/session/[id]/edit/route.ts`

- [ ] **Step 1: Write the route**

Create `preview/app/api/session/[id]/edit/route.ts`:

```typescript
import {spawn} from 'node:child_process';
import {spawnJson} from '../../../_spawn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Single-flight: one edit at a time (shared spec.json + assets, like /api/generate).
let editing = false;

const copyAssets = () =>
  new Promise<void>((resolve) => {
    const cp = spawn('npm', ['run', 'copy-assets'], {cwd: process.cwd(), env: process.env, shell: false});
    cp.on('error', () => resolve());
    cp.on('close', () => resolve());
  });

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body?.op !== 'pick' || typeof body.scene !== 'number' || typeof body.rank !== 'number') {
    return Response.json({error: 'expected {op:"pick", scene:number, rank:number}'}, {status: 400});
  }
  if (editing) {
    return Response.json({error: 'an edit is already in progress'}, {status: 409});
  }
  editing = true;
  try {
    const {code, json} = await spawnJson('session_edit.py', [
      '--sid', id, '--op', 'pick', '--scene', String(body.scene), '--rank', String(body.rank),
    ]);
    if (code !== 0 || json?.ok === false) {
      return Response.json({error: json?.error ?? 'edit failed'}, {status: 400});
    }
    await copyAssets(); // mirror any newly-referenced asset into preview/public
    return Response.json(json); // {ok, sid, scene, selectedRank, provenance}
  } catch (e) {
    return Response.json({error: e instanceof Error ? e.message : 'edit failed'}, {status: 500});
  } finally {
    editing = false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add preview/app/api/session
git commit -m "feat(a6.1): POST /api/session/[id]/edit route (single-flight + copy-assets)"
```

---

## Task 8: Generate route surfaces the `sid`

**Files:**
- Modify: `preview/app/api/generate/route.ts:119-135` (PROGRESS parse) + `:146-149` (done event)

- [ ] **Step 1: Capture the session PROGRESS line**

In `preview/app/api/generate/route.ts`, add a `sid` accumulator before the stream `start` (near line 80, inside `start(controller)`): add `let sid: string | null = null;` alongside `let stderrTail = '';`.

Then in the stdout PROGRESS loop (the `try` block around line 127-133), replace:

```typescript
            const evt = JSON.parse(line.slice(i + 'PROGRESS '.length));
            if (evt && typeof evt.stage === 'string' && typeof evt.state === 'string') {
              send({type: 'stage', stage: evt.stage, state: evt.state});
            }
```

with:

```typescript
            const evt = JSON.parse(line.slice(i + 'PROGRESS '.length));
            if (evt?.stage === 'session' && typeof evt.state === 'string') {
              sid = evt.state; // the resumable session id — not a pipeline stage
            } else if (evt && typeof evt.stage === 'string' && typeof evt.state === 'string') {
              send({type: 'stage', stage: evt.stage, state: evt.state});
            }
```

- [ ] **Step 2: Add `sid` to the done event**

Replace line 149 (`send({type: 'done', spec: '/spec.json'});`) with:

```typescript
          send({type: 'done', spec: '/spec.json', sid});
```

- [ ] **Step 3: Commit**

```bash
git add preview/app/api/generate/route.ts
git commit -m "feat(a6.1): generate route surfaces the session id on done"
```

---

## Task 9: `FootageGate` component

**Files:**
- Create: `preview/components/FootageGate.tsx`

Renders the pool per footage scene; clicking a non-selected thumbnail calls `onPick`.

- [ ] **Step 1: Write the component**

Create `preview/components/FootageGate.tsx`:

```tsx
'use client';

import {Eyebrow} from './ui';

export type Candidate = {rank: number; thumbUrl: string | null; durationFrames: number | null; selected: boolean};
export type GateScene = {
  index: number;
  template: string | null;
  needsFootage: boolean;
  candidates: Candidate[];
  provenance: {source: string} | null;
};

export function FootageGate({
  scenes,
  busy,
  onPick,
}: {
  scenes: GateScene[];
  busy: boolean;
  onPick: (scene: number, rank: number) => void;
}) {
  const footage = scenes.filter((s) => s.needsFootage && s.candidates.length > 0);
  if (footage.length === 0) return null;
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>Footage gate</Eyebrow>
      <p className="mt-2 font-ui text-[12px] text-ink-muted">
        Pick a different clip for any scene — the preview updates live (re-render to export).
      </p>
      <div className="mt-4 flex flex-col gap-5">
        {footage.map((s) => (
          <div key={s.index}>
            <div className="mb-2 font-ui text-[12px] text-ink-secondary">
              Scene {s.index + 1}
              {s.provenance ? <span className="text-ink-muted"> · {s.provenance.source}</span> : null}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {s.candidates.map((c) => (
                <button
                  key={c.rank}
                  disabled={busy || c.selected}
                  onClick={() => onPick(s.index, c.rank)}
                  className={`relative overflow-hidden rounded-md border transition ${
                    c.selected ? 'border-yellow-400 ring-1 ring-yellow-400' : 'border-white/10 hover:border-white/30'
                  } ${busy ? 'opacity-50' : ''}`}
                  title={`rank ${c.rank}`}
                >
                  {c.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbUrl} alt={`clip rank ${c.rank}`} className="aspect-[9/16] w-full object-cover" />
                  ) : (
                    <div className="aspect-[9/16] w-full bg-white/5" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add preview/components/FootageGate.tsx
git commit -m "feat(a6.1): FootageGate component — per-scene pool + click-to-pick"
```

---

## Task 10: Wire the gate into `Studio`

**Files:**
- Modify: `preview/components/Studio.tsx`

- [ ] **Step 1: Add state + imports**

In `preview/components/Studio.tsx`, add the import near the other component imports (after line 16):

```tsx
import {FootageGate, type GateScene} from './FootageGate';
```

Add state next to the existing `useState`s (after line 33):

```tsx
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [gateScenes, setGateScenes] = useState<GateScene[]>([]);
  const [editing, setEditing] = useState(false);
```

- [ ] **Step 2: Capture sid + fetch state on done**

In the `done` branch (replace lines 98-105), set the sid, refresh the spec + Player, then fetch the gate state:

```tsx
          } else if (msg.type === 'done') {
            finished = true;
            const sid = typeof msg.sid === 'string' ? msg.sid : null;
            setSessionId(sid);
            const r = await fetch(`/spec.json?t=${Date.now()}`);
            const s: Spec = await r.json();
            setSpec(s);
            setFailed(false);
            setGenNonce((n) => n + 1);
            toast.success('Video generated', {id: toastId, description: s.meta.title});
            if (sid) {
              try {
                const st = await fetch(`/api/session/${sid}/state`).then((x) => x.json());
                setGateScenes(Array.isArray(st?.scenes) ? st.scenes : []);
              } catch {
                setGateScenes([]);
              }
            }
          }
```

- [ ] **Step 3: Add the pick handler**

Add this method inside `Studio`, after the `generate` function (after line 122):

```tsx
  async function pick(scene: number, rank: number) {
    if (!sessionId || editing) return;
    setEditing(true);
    const toastId = toast.loading('Swapping clip…');
    try {
      const res = await fetch(`/api/session/${sessionId}/edit`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({op: 'pick', scene, rank}),
      });
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      // re-highlight from the edit response (no second /state fetch)
      setGateScenes((prev) =>
        prev.map((s) =>
          s.index === json.scene
            ? {...s, candidates: s.candidates.map((c) => ({...c, selected: c.rank === json.selectedRank}))}
            : s,
        ),
      );
      // reload spec into the live Player (instant); export MP4 is now stale
      const r = await fetch(`/spec.json?t=${Date.now()}`);
      setSpec(await r.json());
      setGenNonce((n) => n + 1);
      toast.success('Clip swapped — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Swap failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }
```

- [ ] **Step 4: Render the gate panel**

In the left controls column, add the gate panel after the `RenderControls` block (after line 177, before the `HistoryList` `motion.div`):

```tsx
          {spec && gateScenes.length > 0 && (
            <motion.div {...rise} transition={{...rise.transition, delay: 0.14}}>
              <FootageGate scenes={gateScenes} busy={editing} onPick={pick} />
            </motion.div>
          )}
```

- [ ] **Step 5: Typecheck the preview**

Run: `cd preview && export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH" && npx tsc --noEmit`
Expected: no errors (the gate types line up; `msg.sid` is read as `string`).

- [ ] **Step 6: Commit**

```bash
git add preview/components/Studio.tsx
git commit -m "feat(a6.1): wire footage gate into Studio (capture sid, fetch state, pick)"
```

---

## Task 11: Full verification + eyes-on gate

**Files:** none (verification only)

- [ ] **Step 1: Backend regression**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: `239` baseline + the new `test_session_cli.py` tests, all green. Record the count.

- [ ] **Step 2: Autopilot byte-identity invariant**

Run: `cd backend && .venv/bin/python -m pytest tests/test_session_autopilot_golden.py -v`
Expected: PASS — the only autopilot change is the extra `("session", sid)` progress event.

- [ ] **Step 3: Preview typecheck**

Run: `cd preview && export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH" && npm run build-registry >/dev/null && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Route smoke (curl) against a real generated session**

Start the dev server (`cd preview && export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:$PATH" && nohup PORT=3100 npm run dev &`), generate one video in the browser (or `curl -N -X POST localhost:3100/api/generate -H 'content-type: application/json' -d '{"topic":"3 facts about coral reefs"}'` and read the `sid` from the `done` SSE), then:

```bash
curl -s localhost:3100/api/session/<sid>/state | python3 -m json.tool   # expect scenes[] with a footage pool
curl -s -X POST localhost:3100/api/session/<sid>/edit -H 'content-type: application/json' \
     -d '{"op":"pick","scene":<footageIdx>,"rank":2}'                    # expect {ok:true, selectedRank:2, …}
```
Expected: state returns the pool; edit returns `{ok:true, selectedRank:2}` and re-materializes `spec.json`.

- [ ] **Step 5: PAUSE — eyes-on the gate in-browser (§8 acceptance gate, MOTION)**

Per the project's eyes-on rhythm: in the browser at `localhost:3100`, generate a video → the **Footage gate** panel shows each footage scene's candidate pool with the auto pick ringed → **click a different clip** → the live Player updates to the new clip (timing unchanged) and a "re-render to export" toast appears → hit **Render** → the exported MP4 carries the chosen clip. Capture the before/after Player frames and deliver them to the operator (per the established channel) for sign-off. Do **not** merge before the operator's eyes-on pass.

- [ ] **Step 6: After sign-off — finish the branch**

Use `superpowers:finishing-a-development-branch`: PR `hitl-a6-1-footage-gate-pick` → `development` (never master).

---

## Self-Review

**Spec coverage:**
- §2 backend CLI entrypoints (`session_state`/`session_edit`, same EngineContext) → Tasks 2,3,4. ✓
- §2.2 edit returns `{ok, scene, selectedRank, provenance}` → Task 4 + assertion. ✓
- §3 generate surfaces `sid` → Tasks 1 (emit) + 8 (forward). ✓
- §4 routes (GET state, POST edit single-flight + copy-assets) → Tasks 6,7 (+5 helper). ✓
- §5 frontend (gate panel, click-pick, re-highlight from response, live Player reload, stale hint, no auto-render) → Tasks 9,10. ✓
- §1 invariants: session reused as-is (Tasks 2-4 resume/edit, no rebuild); autopilot golden green (Task 1 step 5, Task 11 step 2); pick offline (engine `pick`); single-flight (Task 7); fail-loud (Tasks 3,4 + route 4xx/409). ✓
- §7 error handling (bad sid → 404; non-footage/unknown rank → 4xx; concurrent → 409) → Tasks 4,6,7. ✓
- §8 testing incl. E2E eyes-on → Task 11. ✓ (Frontend/route unit tests intentionally replaced by typecheck + curl + eyes-on — no JS harness in the preview app; noted.)

**Placeholder scan:** every code step shows complete code; no TBD/TODO. ✓

**Type consistency:** `build_state`/`apply_pick` signatures + return keys (`sid/scenes/needsFootage/candidates{rank,thumbUrl,durationFrames,selected}/provenance`, `{ok,scene,selectedRank,provenance}`) are identical across the entrypoints (Tasks 3,4), the `spawnJson` consumers (Tasks 6,7), and the React `Candidate`/`GateScene` types + `pick` handler (Tasks 9,10). `job_ctx` constant names match between the module (Task 2) and the monkeypatches (Tasks 3,4). ✓
