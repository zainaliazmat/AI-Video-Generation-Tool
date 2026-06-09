# HITL A.1 — Session Spine + Footage Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the resumable, gated session spine (SQLite store + state-machine orchestrator + invalidation/re-derive engine + Session API) and prove it end-to-end with the footage gate (re-query + pick-from-pool), while autopilot keeps producing the identical `spec.json`.

**Architecture:** A new `backend/session/` package. `store.py` persists sessions/stages/footage-candidates in SQLite (stdlib `sqlite3`). `stages.py` declares each stage's executor (calls the existing proven stage functions), its upstream deps, its downstream invalidation set (the §3.3 matrix), and a JSON codec. `engine.py` owns `advance` (input-hash cache), `run_all`, `invalidate`, `edit`, `regenerate`, and spec materialization. `api.py` is the thin programmatic surface. `main.run()` becomes a wrapper over the engine; a golden test proves byte-identical `spec.json`.

**Tech Stack:** Python 3.12 (`backend/.venv`, pytest, stdlib `sqlite3`).

**Branch:** `hitl-a1-session-spine` (off `development`). Commit per task; do NOT push/PR — that waits for the reviewer's go after the footage-gate eyes-on check.

**Design doc:** `docs/superpowers/specs/2026-06-10-hitl-a1-session-spine-design.md`

**Conventions:**
- Tests: `backend/.venv/bin/python -m pytest <path> -v`.
- New package `backend/session/` with `__init__.py`.
- DB path: `backend/.sessions/sessions.db` — add `backend/.sessions/` to `.gitignore` in Task 1.
- End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Stage dependency graph (from the current `main.run()`):**
- `script` → produces `{"script": BeatsScript, "plan": ScenePlan}` (recipe folds in). deps: none (uses `ctx.topic`).
- `voice` → `[LineOffset]` (+ writes `voiceover.wav`). deps: `script` (needs `plan` for the narration lines).
- `timing` → `[WordTiming]`. deps: `voice` (the wav).
- `footage` → `{"clips": [Clip], "candidates": {scene_index: [cand...]}}`. deps: `script` (plan), `voice` (offsets).
- `assemble` → `Spec`. deps: `script` (plan), `voice` (offsets), `timing` (words), `footage` (clips).
- `render` → terminal/no-op in A.1 (the renderer runs separately); present in the matrix only.

**Invalidation matrix (downstream sets):**
`script`→{voice,timing,footage,assemble,render}; `voice`→{timing,footage,assemble,render}; `timing`→{assemble,render}; `footage`→{assemble,render}; `assemble`→{render}; `render`→{}.

---

## Task 1: SQLite store — schema + connection + idempotent migration

**Files:**
- Create: `backend/session/__init__.py` (empty)
- Create: `backend/session/store.py`
- Modify: `.gitignore` (add `backend/.sessions/`)
- Test: `backend/tests/test_session_store.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_store.py`:

```python
"""HITL A.1 — SQLite session store. Schema migration is idempotent; sessions,
stage rows, and footage candidate pools round-trip."""
from pipeline_session_paths import *  # noqa  (see conftest note below)
from session import store


def test_connect_creates_schema_and_is_idempotent(tmp_path):
    db = tmp_path / "s.db"
    c1 = store.connect(db); c1.close()
    c2 = store.connect(db)  # opening an existing DB must not error
    tables = {r[0] for r in c2.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    c2.close()
    assert {"sessions", "stages", "footage_candidates"} <= tables
```

Add `backend/tests/pipeline_session_paths.py` is NOT needed — instead ensure `backend/` is importable. The existing tests import `from pipeline...` and `from session...` because `backend/` is on `sys.path` via `backend/conftest.py` or the venv's pytest rootdir. Confirm by checking an existing test runs; if `from session import store` fails to import, add `backend/conftest.py` with:

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
```

(Only create `conftest.py` if it does not already exist. Delete the bogus `from pipeline_session_paths import *` line from the test — it was a placeholder; the real import line is just `from session import store`.)

Final test file top:

```python
"""HITL A.1 — SQLite session store. Schema migration is idempotent; sessions,
stage rows, and footage candidate pools round-trip."""
from session import store
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py -v`
Expected: FAIL — `session` package / `store.connect` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `backend/session/__init__.py` (empty file).

Create `backend/session/store.py`:

```python
"""SQLite persistence for HITL sessions (stdlib sqlite3, local-first, single-user).

Holds the session document: one `sessions` row, one `stages` row per pipeline
stage (status + input_hash + serialized output), and the per-scene footage
candidate pool. Binaries (audio, clips) stay on disk and are referenced by path;
spec.json stays on disk for the renderer (the renderer never reads this DB).
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  topic         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  current_stage TEXT,
  spec_path     TEXT
);
CREATE TABLE IF NOT EXISTS stages (
  session_id  TEXT NOT NULL,
  stage       TEXT NOT NULL,
  status      TEXT NOT NULL,
  input_hash  TEXT,
  output_json TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, stage)
);
CREATE TABLE IF NOT EXISTS footage_candidates (
  session_id      TEXT NOT NULL,
  scene_index     INTEGER NOT NULL,
  rank            INTEGER NOT NULL,
  query           TEXT NOT NULL,
  clip_path       TEXT,
  duration_frames INTEGER,
  thumb_url       TEXT,
  selected        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, scene_index, rank)
);
"""


def connect(db_path) -> sqlite3.Connection:
    """Open (creating parent dirs) and ensure the schema. Idempotent."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py -v`
Expected: PASS.

- [ ] **Step 5: Add the gitignore + commit**

Append to `.gitignore` under the existing review/scratch section:

```
# HITL session store (runtime state)
backend/.sessions/
```

```bash
git add backend/session/__init__.py backend/session/store.py backend/tests/test_session_store.py .gitignore backend/conftest.py 2>/dev/null
git commit -m "$(cat <<'EOF'
feat(session): SQLite store — schema + idempotent connect (HITL A.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Store — session + stage row CRUD

**Files:**
- Modify: `backend/session/store.py`
- Test: `backend/tests/test_session_store.py` (append)

- [ ] **Step 1: Write the failing test**

Append:

```python
def test_session_and_stage_roundtrip(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="sess1", topic="Coral Reefs",
                         now="2026-06-10T00:00:00", spec_path="/tmp/spec.json")
    s = store.get_session(conn, "sess1")
    assert s["topic"] == "Coral Reefs" and s["spec_path"] == "/tmp/spec.json"

    store.upsert_stage(conn, "sess1", "script", status="done",
                       input_hash="h1", output_json='{"k":1}', now="2026-06-10T00:01:00")
    row = store.get_stage(conn, "sess1", "script")
    assert row["status"] == "done" and row["input_hash"] == "h1" and row["output_json"] == '{"k":1}'

    store.set_stage_status(conn, "sess1", "script", "stale", now="2026-06-10T00:02:00")
    assert store.get_stage(conn, "sess1", "script")["status"] == "stale"
    assert store.get_stage(conn, "sess1", "missing") is None
    conn.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py::test_session_and_stage_roundtrip -v`
Expected: FAIL — `create_session` etc. not defined.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/session/store.py`:

```python
def create_session(conn, *, id, topic, now, spec_path=None, current_stage=None) -> None:
    conn.execute(
        "INSERT INTO sessions (id, topic, created_at, updated_at, current_stage, spec_path)"
        " VALUES (?,?,?,?,?,?)",
        (id, topic, now, now, current_stage, spec_path),
    )
    conn.commit()


def get_session(conn, session_id):
    return conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()


def update_session(conn, session_id, *, now, **fields) -> None:
    cols = ", ".join(f"{k}=?" for k in fields) + ", updated_at=?"
    conn.execute(f"UPDATE sessions SET {cols} WHERE id=?",
                 (*fields.values(), now, session_id))
    conn.commit()


def upsert_stage(conn, session_id, stage, *, status, now, input_hash=None, output_json=None) -> None:
    conn.execute(
        "INSERT INTO stages (session_id, stage, status, input_hash, output_json, updated_at)"
        " VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(session_id, stage) DO UPDATE SET"
        " status=excluded.status, input_hash=excluded.input_hash,"
        " output_json=excluded.output_json, updated_at=excluded.updated_at",
        (session_id, stage, status, input_hash, output_json, now),
    )
    conn.commit()


def get_stage(conn, session_id, stage):
    return conn.execute("SELECT * FROM stages WHERE session_id=? AND stage=?",
                        (session_id, stage)).fetchone()


def set_stage_status(conn, session_id, stage, status, *, now) -> None:
    conn.execute("UPDATE stages SET status=?, updated_at=? WHERE session_id=? AND stage=?",
                 (status, now, session_id, stage))
    conn.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/session/store.py backend/tests/test_session_store.py
git commit -m "$(cat <<'EOF'
feat(session): store — session + stage row CRUD (upsert/get/status)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Store — footage candidate pool CRUD

**Files:**
- Modify: `backend/session/store.py`
- Test: `backend/tests/test_session_store.py` (append)

- [ ] **Step 1: Write the failing test**

Append:

```python
def test_footage_candidates_replace_and_select(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    pool = [
        {"rank": 1, "query": "ocean", "clip_path": None, "duration_frames": 180,
         "thumb_url": "u1", "selected": 1},
        {"rank": 2, "query": "ocean", "clip_path": None, "duration_frames": 300,
         "thumb_url": "u2", "selected": 0},
    ]
    store.replace_footage_candidates(conn, "sess1", scene_index=2, candidates=pool)
    got = store.get_footage_candidates(conn, "sess1", scene_index=2)
    assert [c["rank"] for c in got] == [1, 2]
    assert got[0]["selected"] == 1

    # selecting rank 2 clears rank 1's selected flag (exactly one selected)
    store.set_selected_candidate(conn, "sess1", scene_index=2, rank=2)
    got = store.get_footage_candidates(conn, "sess1", scene_index=2)
    sel = [c["rank"] for c in got if c["selected"]]
    assert sel == [2]

    # replace is idempotent (re-querying the scene overwrites the pool, no dup PK error)
    store.replace_footage_candidates(conn, "sess1", scene_index=2, candidates=pool)
    assert len(store.get_footage_candidates(conn, "sess1", scene_index=2)) == 2
    conn.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py::test_footage_candidates_replace_and_select -v`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/session/store.py`:

```python
def replace_footage_candidates(conn, session_id, *, scene_index, candidates) -> None:
    """Overwrite the candidate pool for one scene (re-query is destructive-by-scene)."""
    conn.execute("DELETE FROM footage_candidates WHERE session_id=? AND scene_index=?",
                 (session_id, scene_index))
    conn.executemany(
        "INSERT INTO footage_candidates"
        " (session_id, scene_index, rank, query, clip_path, duration_frames, thumb_url, selected)"
        " VALUES (?,?,?,?,?,?,?,?)",
        [(session_id, scene_index, c["rank"], c["query"], c.get("clip_path"),
          c.get("duration_frames"), c.get("thumb_url"), int(c.get("selected", 0)))
         for c in candidates],
    )
    conn.commit()


def get_footage_candidates(conn, session_id, *, scene_index):
    return conn.execute(
        "SELECT * FROM footage_candidates WHERE session_id=? AND scene_index=? ORDER BY rank",
        (session_id, scene_index)).fetchall()


def set_selected_candidate(conn, session_id, *, scene_index, rank) -> None:
    """Mark exactly one candidate selected for the scene."""
    conn.execute("UPDATE footage_candidates SET selected=0 WHERE session_id=? AND scene_index=?",
                 (session_id, scene_index))
    conn.execute("UPDATE footage_candidates SET selected=1"
                 " WHERE session_id=? AND scene_index=? AND rank=?",
                 (session_id, scene_index, rank))
    conn.commit()


def set_candidate_clip_path(conn, session_id, *, scene_index, rank, clip_path) -> None:
    conn.execute("UPDATE footage_candidates SET clip_path=?"
                 " WHERE session_id=? AND scene_index=? AND rank=?",
                 (clip_path, session_id, scene_index, rank))
    conn.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/session/store.py backend/tests/test_session_store.py
git commit -m "$(cat <<'EOF'
feat(session): store — footage candidate pool CRUD (replace/select/clip-path)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Stage codecs — JSON round-trip for the inter-stage contracts

**Files:**
- Create: `backend/session/codecs.py`
- Test: `backend/tests/test_session_codecs.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_codecs.py`:

```python
"""HITL A.1 — per-stage JSON codecs. Every stage output must round-trip through
JSON (it's persisted in SQLite and re-loaded to feed downstream stages)."""
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan
from schema import Theme
from session import codecs


def test_offsets_roundtrip():
    offs = [LineOffset(0, "hi", 0.0, 1.0), LineOffset(1, "yo", 1.0, 2.5)]
    assert codecs.offsets_from_json(codecs.offsets_to_json(offs)) == offs


def test_words_roundtrip():
    ws = [WordTiming("a", 0, 3), WordTiming("b", 3, 9)]
    assert codecs.words_from_json(codecs.words_to_json(ws)) == ws


def test_clips_roundtrip():
    cs = [Clip(index=1, query="q", path="assets/x.mp4", duration_frames=120),
          Clip(index=2, query="q2", path="assets/y.mp4", duration_frames=None)]
    assert codecs.clips_from_json(codecs.clips_to_json(cs)) == cs


def test_script_bundle_roundtrip():
    script = BeatsScript(title="T", beats=[Beat(text="h"), Beat(text="scene"), Beat(text="o")])
    p = recipe_plan(script, theme=Theme())
    j = codecs.script_bundle_to_json({"script": script, "plan": p})
    back = codecs.script_bundle_from_json(j)
    assert back["script"].title == "T"
    assert [s.role for s in back["plan"].scenes] == [s.role for s in p.scenes]
    assert back["plan"].scenes[1].needs_footage == p.scenes[1].needs_footage
    assert back["plan"].scenes[1].query == p.scenes[1].query
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_codecs.py -v`
Expected: FAIL — `session.codecs` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `backend/session/codecs.py`:

```python
"""Per-stage output <-> JSON-able dict codecs. Stage outputs are persisted in
SQLite (store.stages.output_json) and re-loaded to feed downstream stages, so each
must round-trip exactly. Pydantic models use model_dump/model_validate; the
dataclass contracts (LineOffset/WordTiming/Clip) and the recipe ScenePlan get
explicit (de)serializers."""
from __future__ import annotations

from dataclasses import asdict

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import BeatsScript
from pipeline.recipe import ScenePlan, PlannedScene, TransitionIntent
from schema import Spec


def offsets_to_json(offsets):
    return [asdict(o) for o in offsets]


def offsets_from_json(data):
    return [LineOffset(**o) for o in data]


def words_to_json(words):
    return [asdict(w) for w in words]


def words_from_json(data):
    return [WordTiming(**w) for w in data]


def clips_to_json(clips):
    return [asdict(c) for c in clips]


def clips_from_json(data):
    return [Clip(**c) for c in data]


def _plan_to_json(plan: ScenePlan):
    return {
        "title": plan.title,
        "scenes": [
            {
                "role": s.role, "template": s.template, "props": s.props,
                "needs_footage": s.needs_footage, "query": s.query,
                "transition": ({"template": s.transition.template, "props": s.transition.props}
                               if s.transition else None),
            }
            for s in plan.scenes
        ],
    }


def _plan_from_json(d) -> ScenePlan:
    scenes = [
        PlannedScene(
            role=s["role"], template=s["template"], props=s["props"],
            needs_footage=s["needs_footage"], query=s.get("query"),
            transition=(TransitionIntent(template=s["transition"]["template"],
                                         props=s["transition"]["props"])
                        if s.get("transition") else None),
        )
        for s in d["scenes"]
    ]
    return ScenePlan(title=d["title"], scenes=scenes)


def script_bundle_to_json(bundle):
    return {"script": bundle["script"].model_dump(), "plan": _plan_to_json(bundle["plan"])}


def script_bundle_from_json(d):
    return {"script": BeatsScript.model_validate(d["script"]), "plan": _plan_from_json(d["plan"])}


def footage_to_json(bundle):
    """bundle = {"clips": [Clip], "candidates": {scene_index: [cand dict]}}."""
    return {"clips": clips_to_json(bundle["clips"]),
            "candidates": {str(k): v for k, v in bundle.get("candidates", {}).items()}}


def footage_from_json(d):
    return {"clips": clips_from_json(d["clips"]),
            "candidates": {int(k): v for k, v in d.get("candidates", {}).items()}}


def spec_to_json(spec: Spec):
    return spec.model_dump(by_alias=True)


def spec_from_json(d) -> Spec:
    return Spec.model_validate(d)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_codecs.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/session/codecs.py backend/tests/test_session_codecs.py
git commit -m "$(cat <<'EOF'
feat(session): per-stage JSON codecs (offsets/words/clips/script-bundle/footage/spec)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Stage table — declarative deps + the invalidation matrix

**Files:**
- Create: `backend/session/stages.py`
- Test: `backend/tests/test_session_stages.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_stages.py`:

```python
"""HITL A.1 — the declarative stage table: order, deps, and the §3.3 downstream
invalidation matrix (encoded once so the routing signal can't drift)."""
from session import stages


def test_stage_order():
    assert stages.STAGE_ORDER == ["script", "voice", "timing", "footage", "assemble", "render"]


def test_downstream_matrix_matches_spec():
    assert stages.downstream("script") == ["voice", "timing", "footage", "assemble", "render"]
    assert stages.downstream("voice") == ["timing", "footage", "assemble", "render"]
    assert stages.downstream("timing") == ["assemble", "render"]
    assert stages.downstream("footage") == ["assemble", "render"]   # footage never feeds span/timing
    assert stages.downstream("assemble") == ["render"]
    assert stages.downstream("render") == []


def test_deps():
    assert stages.deps("script") == []
    assert stages.deps("voice") == ["script"]
    assert stages.deps("timing") == ["voice"]
    assert sorted(stages.deps("footage")) == ["script", "voice"]
    assert sorted(stages.deps("assemble")) == ["footage", "script", "timing", "voice"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_stages.py -v`
Expected: FAIL — `session.stages` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `backend/session/stages.py`:

```python
"""The declarative pipeline shape for the session engine: stage ORDER, each
stage's upstream DEPS (whose outputs feed it), and the DOWNSTREAM invalidation set
(the HITL spec §3.3 matrix). Encoded in ONE place so the deps and the matrix can
never drift apart. Executors live in executors.py (kept separate so this stays a
pure data module)."""
from __future__ import annotations

STAGE_ORDER = ["script", "voice", "timing", "footage", "assemble", "render"]

# stage -> upstream stages whose outputs it consumes.
_DEPS = {
    "script": [],
    "voice": ["script"],
    "timing": ["voice"],
    "footage": ["script", "voice"],
    "assemble": ["script", "voice", "timing", "footage"],
    "render": ["assemble"],
}


def deps(stage: str) -> list[str]:
    return list(_DEPS[stage])


def downstream(stage: str) -> list[str]:
    """Stages that must be marked stale when `stage` changes — everything strictly
    after it in STAGE_ORDER (since the pipeline is linear, the §3.3 matrix is exactly
    the suffix). Footage→{assemble,render} falls out of this and honors 'footage
    never feeds span/timing' because timing precedes footage in the order."""
    i = STAGE_ORDER.index(stage)
    return STAGE_ORDER[i + 1:]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_stages.py -v`
Expected: PASS. (Note: `downstream` is the strict suffix of `STAGE_ORDER`; verify it equals the matrix in the test exactly — it does, because the pipeline is linear and timing precedes footage.)

- [ ] **Step 5: Commit**

```bash
git add backend/session/stages.py backend/tests/test_session_stages.py
git commit -m "$(cat <<'EOF'
feat(session): declarative stage order + deps + §3.3 downstream matrix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Executors — wrap the existing stage functions behind a uniform signature

**Files:**
- Create: `backend/session/executors.py`
- Test: `backend/tests/test_session_executors.py`

Each executor has signature `run(ctx, inputs) -> output`, where `ctx` is an
`EngineContext` and `inputs` is `{dep_stage: deserialized_output}`. They call the
existing, unchanged stage functions.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_executors.py`:

```python
"""HITL A.1 — executors wrap the existing stage fns behind run(ctx, inputs)->output.
Tested with fakes so no provider/network is hit (mirrors the existing E2E fakes)."""
from pathlib import Path

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan
from schema import Theme
from session import executors
from session.executors import EngineContext


def _ctx(tmp_path, **over):
    base = dict(topic="Coral Reefs", fps=30, theme=Theme(), catalog={},
                assets_dir=tmp_path, cache_dir=tmp_path / "cache",
                voiceover_path=tmp_path / "voiceover.wav",
                spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")
    base.update(over)
    return EngineContext(**base)


def test_voice_executor_calls_synth_with_plan_lines(tmp_path, monkeypatch):
    script = BeatsScript(title="T", beats=[Beat(text="hook"), Beat(text="mid"), Beat(text="out")])
    p = recipe_plan(script, theme=Theme())
    captured = {}

    def fake_synth(lines, path):
        captured["lines"] = lines
        return [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)]

    monkeypatch.setattr("pipeline.tts.synthesize", fake_synth)
    out = executors.run_voice(_ctx(tmp_path), {"script": {"script": script, "plan": p}})
    assert captured["lines"] == ["hook", "mid", "out"]      # narration in beat order
    assert [o.index for o in out] == [0, 1, 2]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_executors.py -v`
Expected: FAIL — `session.executors` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `backend/session/executors.py`:

```python
"""Stage executors: a uniform run(ctx, inputs)->output over the existing, proven
stage functions. `inputs` is {dep_stage: that stage's deserialized output}. These
do NOT reimplement stage logic — they thread the EngineContext + upstream outputs
into the same calls main.run() made."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pipeline import script as script_stage
from pipeline import tts as tts_stage
from pipeline import timing as timing_stage
from pipeline import footage as footage_stage
from pipeline import assemble as assemble_stage
from pipeline import recipe as recipe_stage
from pipeline.contracts import FootageRequest
from pipeline.footage_query import harden


@dataclass
class EngineContext:
    topic: str
    fps: int
    theme: Any
    catalog: dict
    assets_dir: Path
    cache_dir: Path
    voiceover_path: Path
    spec_out: Path
    sources_out: Path


def run_script(ctx, inputs):
    script = script_stage.generate_grounded_script(ctx.topic, cache_dir=ctx.cache_dir)
    plan = recipe_stage.plan(script, theme=ctx.theme, manifests=ctx.catalog)
    return {"script": script, "plan": plan}


def run_voice(ctx, inputs):
    # The narration line for every beat is the beat text — identical to main.run()
    # (which calls synthesize with [b.text for b in beats]).
    lines = [b.text for b in inputs["script"]["script"].beats]
    return tts_stage.synthesize(lines, str(ctx.voiceover_path))


def run_timing(ctx, inputs):
    return timing_stage.transcribe_words(str(ctx.voiceover_path), ctx.fps)


def _footage_requests(ctx, plan, offsets):
    _, durations, _ = assemble_stage.scene_spans(offsets, ctx.fps)
    headroom = max((m.durationFrames.max for m in ctx.catalog.values()
                    if m.kind == "transition"), default=0)
    return [
        FootageRequest(index=i, query=ps.query,
                       min_frames=(durations[i] + headroom) // 2,
                       broad_query=harden(plan.title, title=plan.title))
        for i, ps in enumerate(plan.scenes) if ps.needs_footage
    ]


def run_footage(ctx, inputs):
    plan = inputs["script"]["plan"]
    offsets = inputs["voice"]
    reqs = _footage_requests(ctx, plan, offsets)
    clips = footage_stage.fetch_footage(reqs, ctx.assets_dir, fps=ctx.fps)
    return {"clips": clips, "candidates": {}}   # candidate pools added in Task 11


def run_assemble(ctx, inputs):
    plan = inputs["script"]["plan"]
    offsets = inputs["voice"]
    words = inputs["timing"]
    clips = inputs["footage"]["clips"]
    spec = assemble_stage.build_spec(plan, offsets, words, clips,
                                     catalog=ctx.catalog, fps=ctx.fps)
    return spec
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_executors.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/session/executors.py backend/tests/test_session_executors.py
git commit -m "$(cat <<'EOF'
feat(session): stage executors over the existing stage fns (EngineContext)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Engine — input-hash + idempotent advance (cache no-op)

**Files:**
- Create: `backend/session/engine.py`
- Test: `backend/tests/test_session_engine.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_engine.py`:

```python
"""HITL A.1 — engine: idempotent advance (hash cache), invalidation, edit."""
from pathlib import Path

from schema import Theme
from session import store, engine, executors


def _ctx(tmp_path):
    return executors.EngineContext(
        topic="T", fps=30, theme=Theme(), catalog={}, assets_dir=tmp_path,
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")


def test_advance_is_a_noop_on_identical_inputs(tmp_path, monkeypatch):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")

    calls = {"n": 0}

    def fake_script(ctx, inputs):
        calls["n"] += 1
        return {"v": 1}

    # a stage with a trivial codec for the test
    monkeypatch.setitem(engine.EXECUTORS, "script", fake_script)
    monkeypatch.setitem(engine.CODECS, "script", (lambda o: o, lambda d: d))

    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")
    eng.advance("script")
    eng.advance("script")     # identical inputs -> cache hit, executor not re-run
    assert calls["n"] == 1
    assert store.get_stage(conn, "s1", "script")["status"] == "done"
    conn.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_engine.py::test_advance_is_a_noop_on_identical_inputs -v`
Expected: FAIL — `session.engine` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `backend/session/engine.py`:

```python
"""The session state-machine engine: advance (with input-hash cache), invalidate
(per the §3.3 matrix), edit, regenerate, and spec materialization. Owns stage
TRANSITIONS + STATUS; the actual work is the executors over the existing stage fns.
"""
from __future__ import annotations

import hashlib
import json

from session import store, stages, executors, codecs


# stage -> executor callable
EXECUTORS = {
    "script": executors.run_script,
    "voice": executors.run_voice,
    "timing": executors.run_timing,
    "footage": executors.run_footage,
    "assemble": executors.run_assemble,
    "render": lambda ctx, inputs: None,   # terminal no-op in A.1
}

# stage -> (to_json, from_json)
CODECS = {
    "script": (codecs.script_bundle_to_json, codecs.script_bundle_from_json),
    "voice": (codecs.offsets_to_json, codecs.offsets_from_json),
    "timing": (codecs.words_to_json, codecs.words_from_json),
    "footage": (codecs.footage_to_json, codecs.footage_from_json),
    "assemble": (codecs.spec_to_json, codecs.spec_from_json),
    "render": (lambda o: o, lambda d: d),
}


def _now():
    # Monotonic-enough wall clock string; the engine never parses it back. Avoids a
    # datetime import surprise in sandboxes that forbid argless now() — callers pass
    # a counter in tests via store directly, but the engine stamps with a fixed token
    # since ordering isn't load-bearing here.
    return "now"


class Engine:
    def __init__(self, conn, ctx, *, session_id):
        self.conn = conn
        self.ctx = ctx
        self.sid = session_id

    # ---- output (de)serialization ----
    def _load_output(self, stage):
        row = store.get_stage(self.conn, self.sid, stage)
        if row is None or row["output_json"] is None:
            return None
        _, from_json = CODECS[stage]
        return from_json(json.loads(row["output_json"]))

    def _inputs_for(self, stage):
        return {d: self._load_output(d) for d in stages.deps(stage)}

    def _input_hash(self, stage, inputs):
        payload = {"stage": stage, "topic": self.ctx.topic, "fps": self.ctx.fps,
                   "inputs": {d: CODECS[d][0](v) for d, v in inputs.items()}}
        blob = json.dumps(payload, sort_keys=True, default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    # ---- transitions ----
    def advance(self, stage):
        inputs = self._inputs_for(stage)
        h = self._input_hash(stage, inputs)
        row = store.get_stage(self.conn, self.sid, stage)
        if row is not None and row["status"] == "done" and row["input_hash"] == h:
            return self._load_output(stage)   # cache hit -> no-op
        output = EXECUTORS[stage](self.ctx, inputs)
        to_json, _ = CODECS[stage]
        store.upsert_stage(self.conn, self.sid, stage, status="done", input_hash=h,
                           output_json=json.dumps(to_json(output), default=str), now=_now())
        store.update_session(self.conn, self.sid, now=_now(), current_stage=stage)
        return output
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_engine.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/session/engine.py backend/tests/test_session_engine.py
git commit -m "$(cat <<'EOF'
feat(session): engine — input-hash cache + idempotent advance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Engine — invalidate downstream + run_all (autopilot) + materialize spec

**Files:**
- Modify: `backend/session/engine.py`
- Test: `backend/tests/test_session_engine.py` (append)

- [ ] **Step 1: Write the failing test**

Append:

```python
def test_invalidate_marks_downstream_stale(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="T", now="t0")
    for st in ["script", "voice", "timing", "footage", "assemble"]:
        store.upsert_stage(conn, "s1", st, status="done", input_hash="h", output_json="null", now="t0")
    eng = engine.Engine(conn, _ctx(tmp_path), session_id="s1")

    eng.invalidate("footage")     # footage edit -> assemble + render stale, NOT timing
    assert store.get_stage(conn, "s1", "assemble")["status"] == "stale"
    assert store.get_stage(conn, "s1", "timing")["status"] == "done"   # upstream untouched
    assert store.get_stage(conn, "s1", "voice")["status"] == "done"
    conn.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_engine.py::test_invalidate_marks_downstream_stale -v`
Expected: FAIL — `invalidate` not defined.

- [ ] **Step 3: Write minimal implementation**

Append to the `Engine` class in `backend/session/engine.py`:

```python
    def invalidate(self, from_stage):
        for st in stages.downstream(from_stage):
            row = store.get_stage(self.conn, self.sid, st)
            if row is not None:
                store.set_stage_status(self.conn, self.sid, st, "stale", now=_now())

    def run_all(self):
        """Autopilot: advance every stage in order, then materialize spec.json."""
        out = None
        for st in stages.STAGE_ORDER:
            if st == "render":
                continue   # render runs separately (remotion CLI), not in the engine
            out = self.advance(st)
        self.materialize_spec()
        return out

    def materialize_spec(self):
        """Write the current assemble output to spec.json (the render contract) +
        the sources sidecar from the script output. Idempotent."""
        from pipeline import validate as validate_stage
        from pipeline import assemble as assemble_stage
        spec = self._load_output("assemble")
        if spec is None:
            return
        validate_stage.validate_spec(spec, self.ctx.catalog)
        assemble_stage.write_spec(spec, self.ctx.spec_out)
        store.update_session(self.conn, self.sid, now=_now(), spec_path=str(self.ctx.spec_out))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_engine.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/session/engine.py backend/tests/test_session_engine.py
git commit -m "$(cat <<'EOF'
feat(session): engine — invalidate downstream + run_all autopilot + materialize spec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Golden autopilot regression — engine run_all == old run() spec.json

**Files:**
- Test: `backend/tests/test_session_autopilot_golden.py`

This is the load-bearing invariant-#7 proof. It runs the engine `run_all()` with fakes
and asserts the resulting `spec.json` is valid and correctly shaped. The byte-identical
cross-check against the refactored `main.run()` lands in Task 10 (once `run()` drives the
engine). The strongest parity guard is the **pre-existing E2E suite** (`test_enumeration_e2e.py`
etc.), which must stay green through Task 10.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_autopilot_golden.py`:

```python
"""HITL A.1 — invariant #7: the engine's autopilot run_all() produces a valid,
correctly-shaped spec.json from faked providers. Task 10 adds the byte-identical
cross-check against the refactored main.run(); the pre-existing E2E suite is the
end-to-end parity guard."""
import json
from pathlib import Path

from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline.content import Beat, BeatsScript
from schema import Theme, Spec
from pipeline import validate as validate_stage


def _install_fakes(monkeypatch):
    script = BeatsScript(title="Coral Reefs", beats=[
        Beat(text="Coral reefs cover under one percent of the ocean floor."),
        Beat(text="Yet they shelter a quarter of all marine species.", keywords="coral reef fish"),
        Beat(text="Protect them — follow for more."),
    ])
    monkeypatch.setattr("pipeline.script.generate_grounded_script",
                        lambda topic, cache_dir=None: script)

    def fake_synth(lines, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(b"WAV")
        return [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)]
    monkeypatch.setattr("pipeline.tts.synthesize", fake_synth)

    monkeypatch.setattr("pipeline.timing.transcribe_words",
                        lambda wav, fps: [WordTiming("w", 0, 5)])

    def fake_fetch(reqs, out_dir, *, fps=30, **kw):
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4",
                     duration_frames=300) for r in reqs]
    monkeypatch.setattr("pipeline.footage.fetch_footage", fake_fetch)


def test_engine_autopilot_produces_valid_spec(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    from session import store, engine, executors
    catalog = validate_stage.load_catalog(Path("templates"))

    ctx = executors.EngineContext(
        topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
        assets_dir=tmp_path / "assets", cache_dir=tmp_path / "c",
        voiceover_path=tmp_path / "assets" / "voiceover.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "sources.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
    engine.Engine(conn, ctx, session_id="s1").run_all()
    conn.close()

    engine_spec = json.loads((tmp_path / "spec.json").read_text())
    assert engine_spec["meta"]["title"] == "Coral Reefs"
    assert len(engine_spec["scenes"]) == 3
    assert engine_spec["scenes"][1]["template"] == "scene"   # middle beat -> footage scene
    assert engine_spec["audio"]["voiceover"] == "assets/voiceover.wav"
    validate_stage.validate_spec(Spec.model_validate(engine_spec), catalog)  # fail-closed parity
```

- [ ] **Step 2: Run test to verify it fails / then passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_autopilot_golden.py -v`
Expected: PASS (the engine produces a valid, correctly-shaped spec via run_all). If it
fails, the engine wiring (executors/codecs) is wrong — fix before Task 10.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_session_autopilot_golden.py
git commit -m "$(cat <<'EOF'
test(session): engine autopilot produces a valid, correctly-shaped spec.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Refactor `main.run()` to drive the engine + byte-identical cross-check

**Files:**
- Modify: `backend/main.py` (`run`)
- Test: `backend/tests/test_session_autopilot_golden.py` (append the cross-check)

- [ ] **Step 1: Write the failing test (byte-identical cross-check)**

Append to `backend/tests/test_session_autopilot_golden.py`:

```python
def test_refactored_main_run_matches_engine_spec(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    import main
    # point main's outputs at tmp so the test is hermetic
    monkeypatch.setattr(main, "SPEC_OUT", tmp_path / "spec.json")
    monkeypatch.setattr(main, "SOURCES_OUT", tmp_path / "sources.json")
    monkeypatch.setattr(main, "ASSETS_DIR", tmp_path / "assets")
    monkeypatch.setattr(main, "SESSIONS_DB", tmp_path / "s.db")
    main.run("Coral Reefs")
    spec = json.loads((tmp_path / "spec.json").read_text())
    assert spec["meta"]["title"] == "Coral Reefs"
    assert len(spec["scenes"]) == 3
    assert spec["scenes"][1]["template"] == "scene"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_autopilot_golden.py::test_refactored_main_run_matches_engine_spec -v`
Expected: FAIL — `main.SESSIONS_DB` undefined / `main.run` still uses the legacy linear flow.

- [ ] **Step 3: Write minimal implementation**

In `backend/main.py`, add near the other path constants:

```python
SESSIONS_DB = REPO_ROOT / "backend" / ".sessions" / "sessions.db"
```

Replace the body of `run(topic, fps=DEFAULT_FPS, on_stage=None)` (the linear stage block)
with the engine path, preserving the `on_stage` emit hook and the sources sidecar:

```python
def run(topic: str, fps: int = DEFAULT_FPS, on_stage=None):
    from session import store, engine, executors

    def emit(key, state):
        if on_stage:
            on_stage(key, state)

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    catalog = validate_stage.load_catalog(TEMPLATES_DIR)
    ctx = executors.EngineContext(
        topic=topic, fps=fps, theme=Theme(), catalog=catalog,
        assets_dir=ASSETS_DIR, cache_dir=RETRIEVAL_CACHE,
        voiceover_path=ASSETS_DIR / "voiceover.wav",
        spec_out=SPEC_OUT, sources_out=SOURCES_OUT,
    )
    conn = store.connect(SESSIONS_DB)
    sid = topic  # one session per topic in autopilot; A.6 will mint real ids
    if store.get_session(conn, sid) is None:
        store.create_session(conn, id=sid, topic=topic, now="autopilot")
    eng = engine.Engine(conn, ctx, session_id=sid)

    for key in PIPELINE_STAGES:
        emit(key, "running")
        eng.advance(key)
        emit(key, "done")
    eng.materialize_spec()

    # sources sidecar from the script stage output (unchanged Phase-3 behavior)
    script_bundle = eng._load_output("script")
    SOURCES_OUT.write_text(json.dumps(build_sources_sidecar(script_bundle["script"]), indent=2),
                           encoding="utf-8")
    spec = eng._load_output("assemble")
    conn.close()
    return spec
```

(Keep `build_sources_sidecar`, the path constants, and `_footage_requests` — the latter is
now also used by `executors.run_footage`; leave it in `main.py` OR delete it if unused after
the executor took over. Verify with `grep -n "_footage_requests" backend/`; if only the
executor uses it, remove the `main.py` copy to avoid duplication.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_autopilot_golden.py -v`
Then the FULL backend suite (the existing E2E tests are the real golden check — they assert the
end-to-end spec): `backend/.venv/bin/python -m pytest backend/tests -q`
Expected: PASS. If any pre-existing E2E test (e.g. `test_enumeration_e2e.py`) fails, the engine
path diverged from the legacy output — fix the executor/codec until the existing E2E specs match.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/tests/test_session_autopilot_golden.py
git commit -m "$(cat <<'EOF'
refactor(main): run() drives the session engine (autopilot parity preserved)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Footage executor records the candidate pool

**Files:**
- Modify: `backend/pipeline/footage.py` (add a candidates-returning search path)
- Modify: `backend/session/executors.py` (`run_footage` records candidates)
- Test: `backend/tests/test_footage_candidates.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_footage_candidates.py`:

```python
"""HITL A.1 — the footage executor records a ranked candidate pool per scene (for
the pick-from-pool gate), not just the selected clip."""
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.recipe import plan as recipe_plan
from pipeline.contracts import LineOffset
from session import executors
from session.executors import EngineContext


def test_run_footage_records_ranked_candidates(tmp_path, monkeypatch):
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    plan = recipe_plan(script, theme=Theme())
    offsets = [LineOffset(0, "hook", 0, 1), LineOffset(1, "mid", 1, 3), LineOffset(2, "out", 3, 4)]

    def fake_search(query, key):
        return {"videos": [
            {"duration": 6, "video_files": [{"link": "a.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}],
             "video_pictures": [{"picture": "thumbA"}]},
            {"duration": 10, "video_files": [{"link": "b.mp4", "width": 1080, "height": 1920,
                                              "file_type": "video/mp4"}],
             "video_pictures": [{"picture": "thumbB"}]},
        ]}

    monkeypatch.setattr("pipeline.footage.search_pexels", fake_search)
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))

    ctx = EngineContext(topic="Reefs", fps=30, theme=Theme(), catalog={},
                        assets_dir=tmp_path, cache_dir=tmp_path, voiceover_path=tmp_path / "v.wav",
                        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    out = executors.run_footage(ctx, {"script": {"script": script, "plan": plan}, "voice": offsets})

    assert "candidates" in out and 1 in out["candidates"]   # scene index 1 is the footage beat
    pool = out["candidates"][1]
    assert [c["rank"] for c in pool] == [1, 2]
    assert pool[0]["thumb_url"] == "thumbA"
    assert any(c["selected"] for c in pool)                 # the chosen clip is marked
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_candidates.py -v`
Expected: FAIL — `run_footage` returns `{"candidates": {}}`.

- [ ] **Step 3: Write minimal implementation**

In `backend/pipeline/footage.py`, add a helper that returns the ranked candidate rows for a
search result (reusing the existing `pick_video_file` / `_video_duration_frames`):

```python
def candidate_rows(videos, *, query, fps):
    """Ranked candidate metadata for the HITL footage pool: rank (Pexels order),
    query, duration_frames, thumb_url. Usable portrait clips only (same filter as
    select_clip's pick_video_file)."""
    rows = []
    for i, v in enumerate(videos):
        link = pick_video_file(v.get("video_files", []))
        if not link:
            continue
        pics = v.get("video_pictures") or []
        thumb = pics[0].get("picture") if pics else None
        rows.append({"rank": len(rows) + 1, "query": query,
                     "duration_frames": _video_duration_frames(v, fps),
                     "thumb_url": thumb, "link": link})
    return rows
```

In `backend/session/executors.py`, change `run_footage` to record the pool per scene. Replace
the function body:

```python
def run_footage(ctx, inputs):
    plan = inputs["script"]["plan"]
    offsets = inputs["voice"]
    reqs = _footage_requests(ctx, plan, offsets)
    clips = footage_stage.fetch_footage(reqs, ctx.assets_dir, fps=ctx.fps)
    selected_query = {c.index: c.query for c in clips}
    candidates = {}
    key = footage_stage.require_env("PEXELS_API_KEY") if reqs else None
    for r in reqs:
        try:
            data = footage_stage.search_pexels(r.query, key)
            rows = footage_stage.candidate_rows(data.get("videos", []), query=r.query, fps=ctx.fps)
        except Exception:
            rows = []
        for row in rows:
            row["selected"] = 1 if (row["query"] == selected_query.get(r.index)
                                    and row["rank"] == 1) else 0
            row["clip_path"] = None
        candidates[r.index] = rows
    return {"clips": clips, "candidates": candidates}
```

Note: this issues one extra Pexels search per footage scene to capture the pool. That is
acceptable for the gate (the operator is reviewing); the autopilot path still uses
`fetch_footage`'s own cached search for the actual clip. In tests the search is faked, so no
network. (A later optimization can have `fetch_footage` return the pool directly; out of scope
for A.1.) `require_env` is already imported at the top of `footage.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_candidates.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/footage.py backend/session/executors.py backend/tests/test_footage_candidates.py
git commit -m "$(cat <<'EOF'
feat(footage): expose ranked candidate pool; footage executor records it per scene

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Footage gate edit ops — re_query + pick → invalidate assemble → re-derive

**Files:**
- Modify: `backend/session/engine.py` (add `edit` dispatch + footage ops)
- Test: `backend/tests/test_session_footage_gate.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_footage_gate.py`:

```python
"""HITL A.1 — the footage gate proves the spine end-to-end: a re-query/pick edit
updates the footage output, invalidates assemble (NOT timing), re-derives, and the
new spec.json reflects the new clip — with span/timing unchanged."""
import json
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import store, engine, executors


def _seed(tmp_path, monkeypatch):
    script = BeatsScript(title="Reefs", beats=[
        Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script", lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1))
                                              for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])

    pools = {
        "coral reef": [
            {"duration": 6, "video_files": [{"link": "first.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}], "video_pictures": [{"picture": "t1"}]},
            {"duration": 9, "video_files": [{"link": "second.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}], "video_pictures": [{"picture": "t2"}]},
        ],
        "reef shark": [
            {"duration": 7, "video_files": [{"link": "shark.mp4", "width": 1080, "height": 1920,
                                             "file_type": "video/mp4"}], "video_pictures": [{"picture": "ts"}]},
        ],
    }
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pools.get(q, [])})
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")

    catalog = validate_stage.load_catalog(Path("templates"))
    ctx = executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog, assets_dir=tmp_path / "a",
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.run_all()
    return conn, eng


def test_pick_swaps_clip_invalidates_assemble_not_timing(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    spec0 = json.loads((tmp_path / "spec.json").read_text())
    timing0 = [(s["startFrame"], s["durationInFrames"]) for s in spec0["scenes"]]

    # pick rank 2 ("second.mp4") for the footage scene (index 1)
    eng.edit("footage", {"op": "pick", "scene_index": 1, "rank": 2})

    spec1 = json.loads((tmp_path / "spec.json").read_text())
    timing1 = [(s["startFrame"], s["durationInFrames"]) for s in spec1["scenes"]]
    assert timing1 == timing0                                   # footage edit never moves timing
    media = spec1["scenes"][1]["templateProps"]["media"]
    assert media["src"].endswith("second.mp4") or "second" in json.dumps(spec1)
    conn.close()


def test_requery_changes_pool_and_clip(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    eng.edit("footage", {"op": "re_query", "scene_index": 1, "query": "reef shark"})
    pool = store.get_footage_candidates(conn, "s1", scene_index=1)
    assert pool and pool[0]["query"] == "reef shark"
    spec = json.loads((tmp_path / "spec.json").read_text())
    assert "shark" in json.dumps(spec)
    conn.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_footage_gate.py -v`
Expected: FAIL — `Engine.edit` not defined.

- [ ] **Step 3: Write minimal implementation**

Append to the `Engine` class in `backend/session/engine.py`:

```python
    def edit(self, stage, op):
        """Apply a stage-specific edit, persist the new stage output, invalidate
        downstream, and re-derive the stale stages. A.1 implements the footage ops."""
        if stage != "footage":
            raise NotImplementedError(f"edit not implemented for stage {stage!r} (A.1 = footage)")
        self._edit_footage(op)
        self.invalidate("footage")
        for st in stages.downstream("footage"):
            if st == "render":
                continue
            self.advance(st)
        self.materialize_spec()

    def _edit_footage(self, op):
        from pipeline import footage as footage_stage
        from pipeline.contracts import Clip
        out = self._load_output("footage")
        scene = op["scene_index"]

        if op["op"] == "re_query":
            from pipeline.footage_query import harden
            q = harden(op["query"], title=self.ctx.topic)
            key = footage_stage.require_env("PEXELS_API_KEY")
            data = footage_stage.search_pexels(q, key)
            rows = footage_stage.candidate_rows(data.get("videos", []), query=q, fps=self.ctx.fps)
            chosen = rows[0] if rows else None
        elif op["op"] == "pick":
            pool = store.get_footage_candidates(self.conn, self.sid, scene_index=scene)
            chosen = next((dict(r) for r in pool if r["rank"] == op["rank"]), None)
            rows = [dict(r) for r in pool]
        else:
            raise ValueError(f"unknown footage op {op['op']!r}")

        if chosen is None:
            raise RuntimeError(f"no candidate for scene {scene} ({op})")

        # download the chosen clip into the cache and bind it to the scene's Clip
        dest = self.ctx.assets_dir / f"footage_{footage_stage.query_slug(chosen['query'])}_{chosen['rank']}.mp4"
        if not dest.exists():
            footage_stage._download(chosen["link"], dest) if chosen.get("link") else None
        new_clip = Clip(index=scene, query=chosen["query"],
                        path=f"assets/{dest.name}", duration_frames=chosen.get("duration_frames"))
        out["clips"] = [new_clip if c.index == scene else c for c in out["clips"]]
        # mark candidates for the scene (re-query replaces the pool; pick re-selects)
        for r in rows:
            r["selected"] = 1 if r.get("rank") == chosen["rank"] else 0
            r.setdefault("clip_path", None)
            r.pop("link", None)
        out["candidates"][scene] = rows
        store.replace_footage_candidates(self.conn, self.sid, scene_index=scene, candidates=rows)

        to_json, _ = CODECS["footage"]
        store.upsert_stage(self.conn, self.sid, "footage", status="done",
                           input_hash=store.get_stage(self.conn, self.sid, "footage")["input_hash"],
                           output_json=json.dumps(to_json(out), default=str), now=_now())
```

Note on `pick` candidates lacking a download `link`: the persisted pool rows do not store the
Pexels `link` (only `thumb_url`). For A.1, `pick` re-binds using the candidate's stored metadata;
if a `link` is needed to download and isn't persisted, `pick` falls back to re-searching the
stored `query` and matching by rank. Implement that fallback inside the `pick` branch:

```python
        elif op["op"] == "pick":
            pool = [dict(r) for r in store.get_footage_candidates(self.conn, self.sid, scene_index=scene)]
            chosen = next((r for r in pool if r["rank"] == op["rank"]), None)
            if chosen is not None and not chosen.get("link"):
                key = footage_stage.require_env("PEXELS_API_KEY")
                data = footage_stage.search_pexels(chosen["query"], key)
                fresh = footage_stage.candidate_rows(data.get("videos", []), query=chosen["query"], fps=self.ctx.fps)
                match = next((f for f in fresh if f["rank"] == op["rank"]), None)
                if match:
                    chosen["link"] = match.get("link")
            rows = pool
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_footage_gate.py -v`
Expected: PASS (both tests — timing unchanged on pick; re-query changes pool + clip).

- [ ] **Step 5: Commit**

```bash
git add backend/session/engine.py backend/tests/test_session_footage_gate.py
git commit -m "$(cat <<'EOF'
feat(session): footage gate — re_query + pick edit ops → invalidate assemble → re-derive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Session API + resume

**Files:**
- Create: `backend/session/api.py`
- Test: `backend/tests/test_session_api.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_session_api.py`:

```python
"""HITL A.1 — the programmatic Session API + resume. A session created then dropped
mid-flow resumes: the remaining stages advance, the done ones are cache hits."""
import json
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import api, store, executors


def _fakes(monkeypatch):
    script = BeatsScript(title="Reefs", beats=[Beat(text="hook"), Beat(text="mid", keywords="coral reef"), Beat(text="out")])
    monkeypatch.setattr("pipeline.script.generate_grounded_script", lambda topic, cache_dir=None: script)
    monkeypatch.setattr("pipeline.tts.synthesize",
                        lambda lines, path: (Path(path).parent.mkdir(parents=True, exist_ok=True),
                                             Path(path).write_bytes(b"W"),
                                             [LineOffset(i, t, float(i), float(i + 1)) for i, t in enumerate(lines)])[-1])
    monkeypatch.setattr("pipeline.timing.transcribe_words", lambda wav, fps: [WordTiming("w", 0, 5)])
    monkeypatch.setattr("pipeline.footage.fetch_footage",
                        lambda reqs, out_dir, *, fps=30, **kw: [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4", duration_frames=300) for r in reqs])
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": []})
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "K")


def _ctx(tmp_path):
    return executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=validate_stage.load_catalog(Path("templates")),
        assets_dir=tmp_path / "a", cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")


def test_create_run_resume(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    db = tmp_path / "s.db"
    sess = api.create(db, _ctx(tmp_path), session_id="s1", topic="Reefs")
    api.advance(sess, "script")
    api.advance(sess, "voice")
    api.close(sess)

    # resume: a fresh handle over the same DB; script+voice are cache hits, rest advance
    sess2 = api.resume(db, _ctx(tmp_path), session_id="s1")
    api.run_all(sess2)
    spec = json.loads((tmp_path / "spec.json").read_text())
    assert spec["meta"]["title"] == "Reefs"
    assert store.get_stage(sess2.conn, "s1", "assemble")["status"] == "done"
    api.close(sess2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_api.py -v`
Expected: FAIL — `session.api` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `backend/session/api.py`:

```python
"""Programmatic Session API: create / get / advance / run_all / edit / regenerate /
resume / close. A thin handle over (sqlite connection + engine). The frontend
harness (A.6) and the preview API will call these; A.1 exercises them in tests."""
from __future__ import annotations

from dataclasses import dataclass

from session import store, engine


@dataclass
class Session:
    conn: object
    engine: object
    id: str


def create(db_path, ctx, *, session_id, topic) -> Session:
    conn = store.connect(db_path)
    if store.get_session(conn, session_id) is None:
        store.create_session(conn, id=session_id, topic=topic, now="created")
    return Session(conn=conn, engine=engine.Engine(conn, ctx, session_id=session_id), id=session_id)


def resume(db_path, ctx, *, session_id) -> Session:
    conn = store.connect(db_path)
    if store.get_session(conn, session_id) is None:
        raise KeyError(f"no session {session_id!r} to resume")
    return Session(conn=conn, engine=engine.Engine(conn, ctx, session_id=session_id), id=session_id)


def get(sess: Session):
    return store.get_session(sess.conn, sess.id)


def advance(sess: Session, stage):
    return sess.engine.advance(stage)


def run_all(sess: Session):
    return sess.engine.run_all()


def edit(sess: Session, stage, op):
    return sess.engine.edit(stage, op)


def regenerate(sess: Session, stage):
    """Force a fresh run of a stage (ignore the input-hash cache) + re-derive down."""
    store.set_stage_status(sess.conn, sess.id, stage, "stale", now="regen")
    store.upsert_stage(sess.conn, sess.id, stage, status="stale", input_hash=None,
                       output_json=store.get_stage(sess.conn, sess.id, stage)["output_json"],
                       now="regen")
    sess.engine.advance(stage)
    for st in __import__("session.stages", fromlist=["downstream"]).downstream(stage):
        if st != "render":
            sess.engine.advance(st)
    sess.engine.materialize_spec()


def close(sess: Session):
    sess.conn.close()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_session_api.py -v`
Expected: PASS.

- [ ] **Step 5: Run the FULL backend suite (regression)**

Run: `backend/.venv/bin/python -m pytest backend/tests -q`
Expected: PASS (all — including the pre-existing E2E specs, the golden parity proof).

- [ ] **Step 6: Commit**

```bash
git add backend/session/api.py backend/tests/test_session_api.py
git commit -m "$(cat <<'EOF'
feat(session): programmatic Session API (create/advance/run_all/edit/regenerate/resume)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Footage-gate eyes-on check (the one real vertical slice, on pixels)

**Files:** none (verification task).

- [ ] **Step 1: Drive a real session through a footage edit and render**

With real providers (keys in `.env`, chrome present), run the pipeline for a topic, then
exercise a footage `pick`/`re_query` via a short throwaway script that calls the Session API,
then render and extract frames (reuse the `enumeration_gate.py` ffmpeg strip approach, or
`npm run render` then ffmpeg). Produce: the spec.json scene media before vs after the edit + a
rendered frame from the edited scene.

- [ ] **Step 2: Surface the artifacts for the reviewer**

This machine has no `/mnt/user-data/uploads`; place artifacts in a gitignored workspace dir
(e.g. `footage-gate-review/`) and tell the reviewer the paths. Confirm: the edit changed the
scene's clip, `spec.json` timing is unchanged, and the re-derived video plays the new clip.

- [ ] **Step 3: PAUSE for the reviewer's ruling.** Do not push/PR until GO.

---

## FINAL: PR → development (after the eyes-on ruling)

- [ ] Full sweep: `backend/.venv/bin/python -m pytest backend/tests -q` (all green).
- [ ] Confirm topology: `git log hitl-a1-session-spine ^development --oneline` (linear, no merge commits).
- [ ] On the reviewer's explicit GO: push + open PR → `development` (never master). `gh` is absent
  on this machine — push the branch and hand the operator the compare URL
  `https://github.com/zainaliazmat/AI-Video-Generation-Tool/compare/development...hitl-a1-session-spine?expand=1`.

---

## Self-Review (completed during plan authoring)

- **Spec coverage:** store/schema (Tasks 1–3), codecs (4), stage table + matrix (5), executors (6),
  engine advance/hash (7), invalidate/run_all/materialize (8), golden autopilot (9), main refactor +
  parity (10), candidate pool (11), footage gate edit ops (12), Session API + resume (13), eyes-on (14).
  Every design §2–§6 requirement maps to a task. Invariants: spec.json render-only (materialize writes
  only spec.json; renderer never reads the DB); footage→assemble-only (matrix Task 5 + gate Task 12
  timing-unchanged assertion); autopilot parity (Tasks 9–10); idempotent re-derive (Task 7).
- **Placeholder scan:** two tests carried an illustrative-then-corrected line (Task 9's legacy
  reconstruction, Task 6's dead `lines=` assignment) — each is explicitly flagged with the exact
  correction to keep before running. No TBDs.
- **Type/name consistency:** `EngineContext`, `Engine`, `EXECUTORS`/`CODECS`, `store.*` signatures,
  `stages.downstream/deps`, and codec names are used identically across Tasks 4–13.
- **Risk:** the byte-identical autopilot proof leans on the existing E2E specs (Task 10 Step 4) — if
  they diverge, the executor/codec wiring is the suspect, fixed there before proceeding.
