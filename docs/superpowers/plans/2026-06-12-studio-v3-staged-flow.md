# Studio v3 — Staged Gates, Scene-Major Editing, Hero Backgrounds, Length Presets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Studio v3 per PRD rev 2.1 (`~/Downloads/studio-v3-staged-flow-PRD (1).md`): pause the pipeline at four human gates (Script → Voice → Scenes → Assemble), make the Scenes gate scene-major (one accordion row per scene), let hero cards carry a dimmed background clip behind the text (gradient = floor + scrim), and parametrize script length (30 s / 60 s / 3 min / 5 min).

**Architecture:** The session engine stays gate-blind and IA-agnostic (PRD §3 — do not rebuild). v3 adds a thin **gatekeeper** layer over it (`backend/session/gates.py` + `backend/session/gatekeeper.py`) that owns WHEN segments run; gate state lives in a new `gates` table; reopen/Re-approve (§4.1) is implemented by deferring the engine's existing re-derive (`edit(..., rederive=False)`), never by new pipeline machinery. Hero backgrounds ride the existing `Media` contract verbatim inside `templateProps` (exactly where the scene template already keeps `media`); pools-for-all-beats reuse `footage_candidates` unchanged. New tables: `gates`, `template_overrides`, `background_overrides`, `pick_log`.

**Tech Stack:** Python (pytest, Pydantic v2, sqlite) for the engine/gatekeeper; zod → JSON-Schema codegen for the templateProps contract; Remotion + vitest for the renderer; Next.js App Router SSE routes (donor: `preview/app/api/generate/route.ts`) spawning the `session_*.py` CLIs.

**Branch:** `studio-v3-staged-flow` off `development` (PRD D2 — nothing to absorb; `hero-card-backgrounds` and all enumeration tiers are already ancestors). Git discipline per §3: feature-branch commits only; push/PR/merge are operator actions; git-guard stays.

**Review pipeline:** this plan goes through `/plan-eng-review` + `/plan-design-review` before any build (house rhythm). The PRD (§4–§9) is normative; where this doc and the PRD conflict, the PRD wins.

**Visual source of truth for M6:** `~/Downloads/studio-v3-staged-flow-mock (1).html` (rev 2 — stateful Script stamp, ember 0.55 flip, done-state single CTA all proven on pixels). The §4.1 blast-radius sheet is spec'd-not-mocked; operator offered to mock it before M6 on request.

---

## Ground-truth deltas (verified on `development` — the PRD's wording vs what the code says)

These were verified while writing this plan; the builder must honor them.

1. **The patch whitelist already admits `scenes[i].templateProps.backgroundClip.*`.** `spec_patch.py::check_path` inspects only `parts[2]` and `templateProps` is in `ALLOWED_SCENE_FIELDS` (`backend/pipeline/spec_patch.py:24,43-69`). PRD §6.2's "extend the assemble whitelist" lands as an **explicit regression test**, not a code change.
2. **A voice `preview` op already exists** (`backend/session_voice.py:50-57`, exposed via `POST /api/session/[id]/voice`), but it synthesizes a canned `SAMPLE_LINE` cached by `(voice, speed)` only. M3 = retarget it to the user's beat 1 with a `(voice, text_hash, speed)` cache key; CLI/route surface unchanged.
3. **PRD §6.1's `POST /api/video/[id]/approve` lands as `POST /api/session/[id]/approve`** — `/video/[id]` is the *page* namespace; the API namespace is `preview/app/api/session/[id]/*` (state/script/voice/timing/assemble/edit all live there). Same for the new start route.
4. **`media` already lives inside `templateProps`** for the scene template (`backend/pipeline/assemble.py:108-110` builds `props = {"media": ...}`; `templates/scene/Component.tsx:30` reads `data.media`). `backgroundClip` inside hero `templateProps` is exactly symmetric — no scene-level contract change.
5. **No `footage_overrides` table exists** (PRD §6.5 says "mirror the existing footage-overrides shape") — the shape reference means the `footage_candidates`/`media_provenance` idiom (`backend/session/store.py:25-51`). `template_overrides` / `background_overrides` / `pick_log` are all new tables.
6. **The sessions table has no params column** (`backend/session/store.py:14-22`), so `auto_run` (M1) and `target_length` (M2) land as guarded `ALTER TABLE` migrations inside `store.connect()` — `CREATE TABLE IF NOT EXISTS` alone can't add columns to existing DBs.
7. **`verify_edited_beats` has no cap of its own** — `max_targeted=3` is a kwarg default on the *batch* `verify_script` (`backend/pipeline/verify.py:51`); the edit path fires one Tavily call per edited index uncapped (`verify.py:133-135`). M2's `EDIT_RECHECK_MAX_TAVILY` is genuinely new behavior, as the PRD says.
8. **The whole-prompt guard is `test_frozen_system_prompt_byte_identical_after_seam`** (`backend/tests/test_studio_script_gate.py:88-97`). D1-B's segment surgery replaces this one test (plus golden-bytes assertions added in M2).

---

## Milestone order & lanes

```
M1 (staged orchestration) ──▶ ┬─ M2 (length presets)        ─┐
                              ├─ M3 (voice previews)         ─┼─▶ M5 (pools · policy · overrides · ②b log) ─▶ M6 (frontend) ─▶ M7 (reviewer gates)
                              └─ M4 (hero bg contract+render)─┘
```

- **M1 first** — everything else surfaces through its gate state machine, and it owns the first `store.py` migration.
- **M2 ∥ M3 ∥ M4 may run as parallel lanes after M1.** Disjoint files: M2 = `pipeline/script.py`, `pipeline/verify.py`, `session/executors.py`, `store.py` (target_length column), `tests/test_studio_script_gate.py`; M3 = `session_voice.py` only; M4 = `templates/*`, `remotion/*`, `backend/tests/test_spec_patch*`. ⚠️ **LANE CONFLICT on `backend/session/store.py`:** M1 adds the `gates` table + `auto_run`; M2 adds `target_length`; M5 adds three tables. Rule: **all `store.py` edits land one lane at a time, in milestone order** (M1 → M2 → M5); M3/M4 never touch it.
- **M5 after M4 and M1** — auto-fill writes `backgroundClip` (M4's contract) and its tables ride `store.py` (after M2's column lands, to keep the migration helper linear).
- **M6 after M1–M5** (consumes every backend surface). **M7 last** — motion artifacts + the live cycles that gate D3's long presets.
- **Per-milestone expansion (house rhythm):** M1 is expanded to bite-sized TDD tasks below and builds first. M2–M7 are scoped at task granularity here (files + tests + gates + normative PRD refs) and each gets its bite-sized expansion when its slot opens, exactly as the template-marketplace plan did for its M2–M5. Operator gates sit between milestones; do not build ahead of the gate.

**Test commands (all milestones):**
- Backend: `backend/.venv/bin/python -m pytest backend/tests -q`
- TS: `npm run test` + `npm run typecheck` in `preview/`, `remotion/`; `npm run typecheck` in `templates/`

---

## M1 — Staged orchestration (BUILDS NOW)

Maps: PRD §6.1, §4, §4.1 (backend semantics). Gate: backend tests green incl. all new tests; preview `tsc` clean; curl E2E (start → PROGRESS lines → approve ×3 → state shows gates); auto-run spec equals `run_all` spec on the same fakes.

Design rulings this milestone encodes (flag at `/plan-eng-review` if disputed):

- **Gate vocabulary (amended per eng-review ruling 1A):** gates are `script | voice | scenes | assemble`; a gate's *segment* is the stages that run to REACH it: `script:[script]`, `voice:[]` (previews are on-demand, M3), `scenes:[voice,timing,footage,assemble]`, `assemble:[]`. **Assemble runs BEFORE the scenes gate** — the per-scene player needs spec.json (PreviewRail fetches `/api/projects/[id]` which reads it off disk), and assemble is pure composition with zero API cost; this deviates from PRD §4's literal diagram (compose moves from scenes-approve to scenes-entry) and is a ruled deviation, not drift. Scene-gate edits are instant via the frontier path. `approve()` is legal for `script/voice/scenes`; the assemble gate is terminal (its action is Render, v2's existing flow).
- **State machine:** state ∈ `awaiting_approval | approved | stale` (PRD §6.1) plus an `approved_at` stamp set on first approval and preserved across stale flips. **Reopen** (first confirmed edit at a completed gate) = owning gate → `awaiting_approval`, reached downstream gates → `stale`. **Re-approve** = ONE `rederive_stale()` pass, then each stale gate restores to `approved` if `approved_at` is set, else `awaiting_approval` — prior human approvals stand; the user lands back where they were (§4.1 "Reopen accumulates; Re-approve pays", one payment, no re-pausing at already-approved gates).
- **Deferral mechanic:** `Engine.edit()` gains `rederive=True` kwarg; the gated reopen path passes `False` (handler runs, `invalidate()` marks downstream stale, NO advance loop, NO `materialize_spec` — spec.json stays at the last approved state until Re-approve). Default `True` keeps every v2 caller byte-identical in behavior.
- **Frontier edits stay v2:** editing at a gate that is `awaiting_approval` (nothing downstream has run) uses the normal `engine.edit` path — re-derive of an empty downstream set is free, and the §4.1 sheet never fires pre-approval.
- **Voice reopen** is regenerate-shaped, not edit-shaped (voice has no edit handler): `gatekeeper.set_voice` = `projects.write_voice` + mark the `voice` stage stale with `input_hash=None` (the first half of `api.regenerate`, `backend/session/api.py:50-65`, without the re-derive) + downstream gates stale. Re-approve pays.

### Task 1: `store.py` — `gates` table, `auto_run` column, migration helper

**Files:**
- Modify: `backend/session/store.py`
- Test: `backend/tests/test_session_store.py` (extend)

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_session_store.py`:

```python
def test_gate_state_roundtrip_and_approved_at_preserved(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    store.upsert_gate_state(conn, "s1", "script", "awaiting_approval", now="t1")
    assert store.get_gate_states(conn, "s1")["script"] == {
        "state": "awaiting_approval", "approved_at": None}
    store.upsert_gate_state(conn, "s1", "script", "approved", now="t2")
    assert store.get_gate_states(conn, "s1")["script"] == {
        "state": "approved", "approved_at": "t2"}
    # stale must NOT erase the approval stamp (the Re-approve restore rule reads it)
    store.upsert_gate_state(conn, "s1", "script", "stale", now="t3")
    g = store.get_gate_states(conn, "s1")["script"]
    assert g["state"] == "stale" and g["approved_at"] == "t2"


def test_unknown_gate_state_rejected(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    with pytest.raises(ValueError):
        store.upsert_gate_state(conn, "s1", "script", "pending", now="t1")


def test_auto_run_defaults_false_and_flips(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="t", now="t0")
    assert store.get_session(conn, "s1")["auto_run"] == 0
    store.set_auto_run(conn, "s1", True, now="t1")
    assert store.get_session(conn, "s1")["auto_run"] == 1


def test_auto_run_column_migrates_pre_v3_db(tmp_path):
    # simulate a pre-v3 DB: sessions table without the auto_run column
    import sqlite3
    db = tmp_path / "old.db"
    raw = sqlite3.connect(db)
    raw.execute("""CREATE TABLE sessions (
        id TEXT PRIMARY KEY, topic TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, current_stage TEXT, spec_path TEXT)""")
    raw.execute("INSERT INTO sessions VALUES ('old1','t','c','u',NULL,NULL)")
    raw.commit(); raw.close()
    conn = store.connect(db)   # must ALTER, not crash
    assert store.get_session(conn, "old1")["auto_run"] == 0
```

- [ ] **Step 2: Run to verify failure** — `backend/.venv/bin/python -m pytest backend/tests/test_session_store.py -q` → FAIL (`upsert_gate_state` undefined; `auto_run` not a column).
- [ ] **Step 3: Implement** in `backend/session/store.py` — add to `_SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS gates (
  session_id  TEXT NOT NULL,
  gate        TEXT NOT NULL,
  state       TEXT NOT NULL,   -- awaiting_approval | approved | stale (PRD §6.1)
  approved_at TEXT,            -- first-approval stamp; survives stale flips (§4.1 restore)
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, gate)
);
```

add the migration call inside `connect()` after schema creation, plus:

```python
GATE_STATES = {"awaiting_approval", "approved", "stale"}


def _migrate(conn):
    """Column additions for DBs created before v3. CREATE TABLE IF NOT EXISTS
    can't add columns, so each new sessions column gets a guarded ALTER here
    (target_length rides M2 through this same helper)."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    if "auto_run" not in cols:
        conn.execute("ALTER TABLE sessions ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 0")
        conn.commit()


def upsert_gate_state(conn, session_id, gate, state, *, now):
    if state not in GATE_STATES:
        raise ValueError(f"unknown gate state {state!r}")
    # the approval stamp exists only when approving; COALESCE preserves the
    # FIRST approval across later stale/awaiting flips (ruling 6A: the rule
    # lives here in Python, not in SQL)
    approved_at = now if state == "approved" else None
    conn.execute(
        """INSERT INTO gates (session_id, gate, state, approved_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, gate) DO UPDATE SET
             state=excluded.state,
             approved_at=COALESCE(gates.approved_at, excluded.approved_at),
             updated_at=excluded.updated_at""",
        (session_id, gate, state, approved_at, now))
    conn.commit()


def get_gate_states(conn, session_id):
    rows = conn.execute(
        "SELECT gate, state, approved_at FROM gates WHERE session_id = ?",
        (session_id,)).fetchall()
    return {r["gate"]: {"state": r["state"], "approved_at": r["approved_at"]}
            for r in rows}


def set_auto_run(conn, session_id, flag, *, now):
    conn.execute("UPDATE sessions SET auto_run = ?, updated_at = ? WHERE id = ?",
                 (1 if flag else 0, now, session_id))
    conn.commit()
```

(One subtlety the COALESCE handles: the first `approved` write wins permanently across later flips.)

- [ ] **Step 3b: delete coverage (ruling 5A).** Add `gates` AND the pre-existing missing `spec_patches` to `delete_session` (`store.py:240-247` enumerates tables by hand — `spec_patches` is a live orphan-row leak on `development` today). Structural test: create a session, populate every table (one row each), `delete_session`, assert **zero rows for the sid across ALL tables** by enumerating `sqlite_master` — any future table missing a delete fails this test immediately.

- [ ] **Step 4: Run to verify pass** — same pytest command → PASS.
- [ ] **Step 5: Commit** — `git add backend/session/store.py backend/tests/test_session_store.py && git commit -m "feat(v3-m1): gates table + auto_run column with guarded migration"`

### Task 2: `gates.py` — gate topology

**Files:**
- Create: `backend/session/gates.py`
- Test: `backend/tests/test_session_gates.py` (new)

- [ ] **Step 1: Write the failing tests** — `backend/tests/test_session_gates.py`:

```python
from session import gates, stages


def test_segments_partition_the_stage_order():
    flat = [s for g in gates.GATE_ORDER for s in gates.GATE_SEGMENTS[g]]
    assert flat == [s for s in stages.STAGE_ORDER if s != "render"]


def test_every_editable_stage_maps_to_one_gate():
    assert set(gates.GATE_FOR_STAGE) == {"script", "voice", "timing", "footage", "assemble"}
    assert set(gates.GATE_FOR_STAGE.values()) <= set(gates.GATE_ORDER)


def test_next_gate_chain():
    assert gates.next_gate("script") == "voice"
    assert gates.next_gate("voice") == "scenes"
    assert gates.next_gate("scenes") == "assemble"
    assert gates.next_gate("assemble") is None


def test_downstream_gates():
    assert gates.downstream_gates("script") == ["voice", "scenes", "assemble"]
    assert gates.downstream_gates("assemble") == []
```

- [ ] **Step 2: Run to verify failure** — `backend/.venv/bin/python -m pytest backend/tests/test_session_gates.py -q` → FAIL (module missing).
- [ ] **Step 3: Implement** — `backend/session/gates.py`:

```python
"""Studio v3 gate topology (PRD §4): four human gates over the stage DAG.

A gate's SEGMENT is the list of stages that run to REACH it; approving a gate
runs the NEXT gate's segment and halts there. The mapping is total: every
editable stage belongs to exactly one gate (the gate that reopens on §4.1
edit intent). The engine stays gate-blind; only gatekeeper.py reads this.
"""
from __future__ import annotations

GATE_ORDER = ["script", "voice", "scenes", "assemble"]

# stages that run to REACH each gate (PRD §4 flow, amended per ruling 1A:
# assemble runs BEFORE the scenes gate so the per-scene player has a spec)
GATE_SEGMENTS = {
    "script": ["script"],                                  # Generate → script gate
    "voice": [],                                           # previews are on-demand (M3)
    "scenes": ["voice", "timing", "footage", "assemble"],  # heavy interstitial + compose
    "assemble": [],                                        # terminal: theme/chat/render
}

# which gate REOPENS when a stage is edited (§4.1)
GATE_FOR_STAGE = {
    "script": "script",
    "voice": "voice",
    "timing": "scenes",
    "footage": "scenes",
    "assemble": "assemble",
}

# DESIGN NOTE (ruling OV-10): gate state is STORED, not derived from stage
# staleness. Derivation cannot attribute a reopen: a footage edit marks the
# assemble STAGE stale, and assemble is downstream of script too — so the
# script gate would wrongly derive "needs re-approval" when only the scenes
# gate reopened. The stored reopened-bit (state=awaiting_approval on an
# approved_at-bearing row) is exactly the information stage staleness can't
# carry. Do not "simplify" this to a derived view.

# the assemble gate is terminal — its tinted action is Render, not Approve
APPROVABLE = ["script", "voice", "scenes"]


def next_gate(gate: str):
    i = GATE_ORDER.index(gate)
    return GATE_ORDER[i + 1] if i + 1 < len(GATE_ORDER) else None


def downstream_gates(gate: str) -> list:
    return GATE_ORDER[GATE_ORDER.index(gate) + 1:]
```

- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): gate topology module"`

### Task 3: `Engine.edit(rederive=)` + `Engine.rederive_stale()`

**Files:**
- Modify: `backend/session/engine.py:123-142`
- Test: `backend/tests/test_session_engine.py` (extend)

- [ ] **Step 1: Write the failing tests** (use the existing `_fakes`/`_ctx` monkeypatch pattern from `test_session_api.py:15-33` — executor call counters prove what ran):

```python
def test_edit_without_rederive_leaves_downstream_stale(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)   # helper: run_all on fakes
    before = dict(calls)
    sess.engine.edit("script", _edit_beat_op(0, "Edited line."), rederive=False)
    # handler ran, downstream marked stale, but NO executor re-ran and spec untouched
    assert calls == before
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st)["status"] == "stale"


def test_rederive_stale_pays_once(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)
    sess.engine.edit("script", _edit_beat_op(0, "Edited line."), rederive=False)
    before = dict(calls)
    ran = sess.engine.rederive_stale()
    assert ran == ["voice", "timing", "footage", "assemble"]
    for st in ran:
        assert store.get_stage(sess.conn, sess.id, st)["status"] == "done"
    assert calls["voice"] == before["voice"] + 1   # exactly one pass


def test_edit_default_rederive_unchanged(tmp_path, monkeypatch):
    # v2 callers pass no kwarg — behavior must stay byte-identical
    calls = _fakes(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)
    sess.engine.edit("script", _edit_beat_op(0, "Edited line."))
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st)["status"] == "done"
```

Module-local helpers for this file (also imported by `test_session_gatekeeper.py` in Tasks 4–8 — or duplicated there, either is fine):

```python
def _session_all_done(tmp_path, monkeypatch):
    sess = _mk_session(tmp_path)
    sess.engine.run_all()
    return sess


def _mk_session(tmp_path, sid="s1"):
    ctx = _ctx(tmp_path, sid=sid)   # the existing per-test ctx factory; give each
    return api.create(tmp_path / "s.db", ctx, session_id=sid, topic="t")
    # sid its own spec_out so two sessions never collide on spec.json


def _edit_beat_op(index, text):
    # the v2 Script-gate op shape (engine._edit_script, engine.py:144-200):
    # verify_fn/retrieve_fn are injected through the op dict; a pass-through
    # verify_fn keeps the edit supported without Tavily.
    return {"op": "edit_beat", "index": index, "text": text,
            "verify_fn": lambda claims: [{**c, "supported": True} for c in claims]}
```

(Before writing these, read `engine._edit_script` (`engine.py:144-200`) and the op literals in `test_studio_script_gate.py` — match the real key names exactly; the shape above is the documented intent, the existing tests are the source of truth.)

- [ ] **Step 2: Run to verify failure** → FAIL (`rederive` unexpected kwarg; `rederive_stale` missing).
- [ ] **Step 3: Implement** in `backend/session/engine.py` — change `edit` and add `rederive_stale`:

```python
def edit(self, stage, op, *, rederive=True):
    """Apply a stage-specific edit, persist the new stage output, invalidate
    downstream, and (by default) re-derive the stale stages. The v3 gated
    reopen path passes rederive=False: edits accumulate, downstream stays
    stale, and Re-approve pays with ONE rederive_stale() (PRD §4.1)."""
    handlers = {
        "footage": self._edit_footage,
        "script": self._edit_script,
        "timing": self._edit_timing,
        "assemble": self._edit_assemble,
    }
    handler = handlers.get(stage)
    if handler is None:
        raise NotImplementedError(f"edit not implemented for stage {stage!r}")
    handler(op)
    self.invalidate(stage)
    if not rederive:
        return
    for st in stages.downstream(stage):
        if st == "render":
            continue
        self.advance(st)
    self.materialize_spec()

def rederive_stale(self, on_stage=None):
    """Re-derive every stale stage in DAG order, then re-materialize the spec.
    The §4.1 Re-approve payment: one pass, regardless of how many edits
    accumulated while the gate was reopened. on_stage(stage, state, elapsed)
    emits REAL stage events (design ruling 1: the Re-approve interstitial is
    the same honest task card as any segment — never a synthetic 'rederive')."""
    import time as _time
    ran = []
    for st in stages.STAGE_ORDER:
        if st == "render":
            continue
        row = store.get_stage(self.conn, self.sid, st)
        if row is not None and row["status"] == "stale":
            t0 = _time.monotonic()
            if on_stage:
                on_stage(st, "running", None)
            self.advance(st)
            if on_stage:
                on_stage(st, "done", round(_time.monotonic() - t0, 1))
            ran.append(st)
    if ran:
        self.materialize_spec()
    return ran
```

- [ ] **Step 4: Run to verify pass**, then run the FULL backend suite (`backend/.venv/bin/python -m pytest backend/tests -q`) — every v2 edit test must stay green (default-path proof).
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): deferred re-derive on Engine.edit + rederive_stale"`

### Task 4: `gatekeeper.start` — run to the script gate

**Files:**
- Create: `backend/session/gatekeeper.py`
- Test: `backend/tests/test_session_gatekeeper.py` (new; reuse `_fakes`/`_ctx` from `test_session_api.py`)

- [ ] **Step 1: Write the failing test:**

```python
def test_start_halts_at_script_gate(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _mk_session(tmp_path)
    events = []
    gatekeeper.start(sess, on_stage=lambda s, st, el: events.append((s, st)))
    assert calls["script"] == 1
    for st in ("voice", "timing", "footage", "assemble"):
        assert store.get_stage(sess.conn, sess.id, st) is None   # never ran
    assert store.get_gate_states(sess.conn, sess.id)["script"]["state"] == "awaiting_approval"
    assert events == [("script", "running"), ("script", "done")]
```

- [ ] **Step 2: Run to verify failure** → FAIL (module missing).
- [ ] **Step 3: Implement** — `backend/session/gatekeeper.py`:

```python
"""Studio v3 gate state machine (PRD §6.1, §4.1) — thin orchestration over the
gate-blind engine. Owns WHEN segments run; never touches HOW stages execute.
on_stage(stage, state, elapsed_s) feeds the interstitial task card through the
PROGRESS→SSE channel (session_gate.py / approve route)."""
from __future__ import annotations

import time

from session import gates, store
from session.engine import _now


def _emit(on_stage, stage, state, t0=None):
    if on_stage is None:
        return
    elapsed = round(time.monotonic() - t0, 1) if t0 is not None else None
    on_stage(stage, state, elapsed)


def _run_segment(sess, gate, on_stage=None):
    """Run the stages that precede `gate`, then open it (awaiting_approval)."""
    for stage in gates.GATE_SEGMENTS[gate]:
        t0 = time.monotonic()
        _emit(on_stage, stage, "running")
        sess.engine.advance(stage)
        _emit(on_stage, stage, "done", t0)
    if "assemble" in gates.GATE_SEGMENTS[gate]:
        sess.engine.materialize_spec()   # spec.json must exist when scenes opens (1A)
    store.upsert_gate_state(sess.conn, sess.id, gate, "awaiting_approval", now=_now())


def start(sess, *, auto_run=False, on_stage=None):
    """Entry from Generate: run to the script gate — or straight through on
    auto-run (PRD §4: approve everything with defaults; same code path)."""
    store.set_auto_run(sess.conn, sess.id, auto_run, now=_now())
    _run_segment(sess, "script", on_stage)
    if auto_run:
        for gate in gates.APPROVABLE:
            approve(sess, gate, on_stage=on_stage)
    return view(sess)


def view(sess):
    row = store.get_session(sess.conn, sess.id)
    return {"gates": store.get_gate_states(sess.conn, sess.id),
            "autoRun": bool(row["auto_run"]),
            "currentStage": row["current_stage"]}
```

(`approve` arrives in Task 5 — for this task stub it as `raise NotImplementedError` so the auto_run branch is honest, and don't test auto_run yet.)

- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): gatekeeper.start halts at the script gate"`

### Task 5: `gatekeeper.approve` — linear approvals

**Files:**
- Modify: `backend/session/gatekeeper.py`
- Test: `backend/tests/test_session_gatekeeper.py` (extend)

- [ ] **Step 1: Write the failing tests:**

```python
def test_approve_script_opens_voice_gate_without_running_anything(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)            # helper: start() done
    before = dict(calls)
    gatekeeper.approve(sess, "script")
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "approved" and g["script"]["approved_at"]
    assert g["voice"]["state"] == "awaiting_approval"
    assert calls == before                            # voice segment is empty


def test_approve_voice_runs_heavy_segment_and_halts_at_scenes(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    events = []
    gatekeeper.approve(sess, "voice", on_stage=lambda s, st, el: events.append((s, st, el)))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["scenes"]["state"] == "awaiting_approval"
    assert store.get_stage(sess.conn, sess.id, "footage")["status"] == "done"
    # ruling 1A: assemble runs INSIDE the scenes segment — spec exists at the
    # scenes gate so the per-scene players have something to play
    assert store.get_stage(sess.conn, sess.id, "assemble")["status"] == "done"
    assert sess.engine.ctx.spec_out.exists()
    # task-card contract: running has no elapsed, done carries elapsed_s
    assert [(s, st) for s, st, _ in events] == [
        ("voice", "running"), ("voice", "done"),
        ("timing", "running"), ("timing", "done"),
        ("footage", "running"), ("footage", "done"),
        ("assemble", "running"), ("assemble", "done")]
    assert all(el is not None for s, st, el in events if st == "done")


def test_approve_scenes_opens_assemble_instantly(tmp_path, monkeypatch):
    # 1A: assemble's own segment is empty — approving scenes is a state flip
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    gatekeeper.approve(sess, "voice")
    before = dict(calls)
    gatekeeper.approve(sess, "scenes")
    assert calls == before
    states = store.get_gate_states(sess.conn, sess.id)
    assert states["assemble"]["state"] == "awaiting_approval"


def test_approve_out_of_order_or_twice_rejected(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        gatekeeper.approve(sess, "voice")             # not open yet
    gatekeeper.approve(sess, "script")
    with pytest.raises(ValueError):
        gatekeeper.approve(sess, "script")            # already approved, next gate open
    with pytest.raises(ValueError):
        gatekeeper.approve(sess, "assemble")          # terminal, not approvable


def test_approve_stale_gate_rejected_names_the_reopened_gate(tmp_path, monkeypatch):
    # ruling OV-2: a stale gate is never the approve target — Re-approve
    # belongs to the gate that reopened, or rederive pays the wrong bill
    _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edited."))   # reopens script
    with pytest.raises(ValueError, match="script"):
        gatekeeper.approve(sess, "scenes")            # stale — not approvable


def test_approve_resumes_after_crash_mid_segment(tmp_path, monkeypatch):
    # ruling 7A: gate approved + next gate row missing = crashed mid-segment;
    # approve is idempotent-forward (done stages no-op via the hash cache)
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")
    # simulate the crash: approve("voice") recorded the approval and ran the
    # voice stage, then the process died before the scenes gate row was written
    store.upsert_gate_state(sess.conn, sess.id, "voice", "approved", now="t-crash")
    sess.engine.advance("voice")
    assert "scenes" not in store.get_gate_states(sess.conn, sess.id)
    gatekeeper.approve(sess, "voice")                 # resumes, does NOT raise
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["scenes"]["state"] == "awaiting_approval"
    assert calls["voice"] == 1                        # cache hit — not re-run
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** in `gatekeeper.py` (replace the stub):

```python
def approve(sess, gate, *, on_stage=None):
    """Approve a gate and auto-start the next segment (PRD §4: no separate
    'continue' click). On a reopened gate this is Re-approve: pay the
    accumulated edits with ONE rederive, then restore downstream gates.

    Two ruled guards:
    - OV-2: a STALE gate is never the approve target — the Re-approve belongs
      to the gate that reopened; the error names it.
    - 7A: approved gate + missing next-gate row = crash mid-segment; approve
      is idempotent-forward and re-enters the segment (done stages no-op via
      the input-hash cache) instead of raising."""
    if gate not in gates.APPROVABLE:
        raise ValueError(f"gate {gate!r} is not approvable (assemble's action is Render)")
    states = store.get_gate_states(sess.conn, sess.id)
    cur = states.get(gate)
    if cur is None:
        raise ValueError(f"gate {gate!r} is not open yet")
    if cur["state"] == "stale":
        reopened = next((g for g in gates.GATE_ORDER
                         if states.get(g, {}).get("state") == "awaiting_approval"), "?")
        raise ValueError(
            f"gate {gate!r} is stale — re-approve gate {reopened!r} first")
    nxt = gates.next_gate(gate)
    if cur["state"] == "approved":
        if nxt is not None and nxt not in states:
            _run_segment(sess, nxt, on_stage)          # 7A crash recovery
            return view(sess)
        raise ValueError(f"gate {gate!r} is already approved")
    if any(s["state"] == "stale" for s in states.values()):
        _reapprove(sess, states, on_stage)
    store.upsert_gate_state(sess.conn, sess.id, gate, "approved", now=_now())
    if nxt is not None:
        nxt_state = store.get_gate_states(sess.conn, sess.id).get(nxt)
        if nxt_state is None or nxt_state["state"] != "approved":
            _run_segment(sess, nxt, on_stage)
    return view(sess)


def _reapprove(sess, states, on_stage):
    """§4.1 payment: one rederive_stale pass emitting REAL per-stage events
    (design ruling 1 — no synthetic 'rederive' card), then each stale gate
    restores to its pre-reopen truth via approved_at."""
    sess.engine.rederive_stale(on_stage)
    for g, s in states.items():
        if s["state"] != "stale":
            continue
        restored = "approved" if s["approved_at"] else "awaiting_approval"
        store.upsert_gate_state(sess.conn, sess.id, g, restored, now=_now())
```

(Note `_run_segment`'s awaiting write is what makes the next gate's halt; after a Re-approve the restored-`approved` next gate skips the segment run — the rederive already did the work.)

- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): gatekeeper.approve — linear approvals + segment auto-start"`

### Task 6: reopen + Re-approve (§4.1) + deferred voice change

**Files:**
- Modify: `backend/session/gatekeeper.py`
- Test: `backend/tests/test_session_gatekeeper.py` (extend)

- [ ] **Step 1: Write the failing tests:**

```python
def test_gated_edit_reopens_and_defers(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)   # helper: 3 approvals done
    before = dict(calls)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edited line."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "awaiting_approval"      # reopened
    assert g["voice"]["state"] == "stale" and g["voice"]["approved_at"]
    assert g["scenes"]["state"] == "stale"
    assert g["assemble"]["state"] == "stale" and not g["assemble"]["approved_at"]
    assert calls == before                                  # nothing re-derived


def test_second_edit_accumulates_without_confirm_state_change(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edit one."))
    snapshot = store.get_gate_states(sess.conn, sess.id)
    gatekeeper.edit(sess, "script", _edit_beat_op(1, "Edit two."))
    assert {k: v["state"] for k, v in store.get_gate_states(sess.conn, sess.id).items()} \
        == {k: v["state"] for k, v in snapshot.items()}


def test_reapprove_pays_once_and_restores(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Edit one."))
    gatekeeper.edit(sess, "script", _edit_beat_op(1, "Edit two."))
    before = dict(calls)
    gatekeeper.approve(sess, "script")                      # Re-approve
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "approved"
    assert g["voice"]["state"] == "approved"                # prior approval stands
    assert g["scenes"]["state"] == "approved"
    assert g["assemble"]["state"] == "awaiting_approval"    # frontier restored
    assert calls["voice"] == before["voice"] + 1            # ONE payment for two edits


def test_frontier_edit_stays_v2(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)                  # script gate awaiting
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Pre-approval edit."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "awaiting_approval"      # no reopen drama
    assert store.get_stage(sess.conn, sess.id, "voice") is None


def test_empty_blast_radius_edit_skips_reopen(tmp_path, monkeypatch):
    # ruling OV-11: script approved, voice gate awaiting (empty segment,
    # nothing downstream RAN) — the edit is free, no reopen, no Re-approve
    calls = _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)
    gatekeeper.approve(sess, "script")                      # voice awaiting
    gatekeeper.edit(sess, "script", _edit_beat_op(0, "Still free."))
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["script"]["state"] == "approved"               # NOT reopened
    assert g["voice"]["state"] == "awaiting_approval"       # NOT stale


def test_set_voice_defers_like_an_edit(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    before = dict(calls)
    gatekeeper.set_voice(sess, voice="af_bella", speed=1.1)
    g = store.get_gate_states(sess.conn, sess.id)
    assert g["voice"]["state"] == "awaiting_approval"
    assert g["scenes"]["state"] == "stale"
    assert store.get_stage(sess.conn, sess.id, "voice")["status"] == "stale"
    assert calls == before
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** in `gatekeeper.py`:

```python
def edit(sess, stage, op):
    """A gated edit. At an approved gate this is the §4.1 reopen: apply WITHOUT
    re-deriving (edits accumulate; Re-approve pays); when the blast radius is
    EMPTY (nothing downstream has run — ruling OV-11) it's plain v2 behavior,
    no sheet, no Re-approve. Voice edits route to set_voice (ruling OV-13 —
    voice is regenerate-shaped, engine.edit has no voice handler). The
    blast-radius sheet's Confirm is what calls this; Cancel never reaches
    the backend."""
    if stage == "voice":
        return set_voice(sess, voice=op["voice"], speed=op.get("speed", 1.0))
    gate = gates.GATE_FOR_STAGE[stage]
    states = store.get_gate_states(sess.conn, sess.id)
    if states.get(gate) is None:
        # 1A corollary: a stage may have run inside an earlier segment before
        # its own gate row exists (assemble at the scenes gate) — that's a
        # frontier edit, not an error
        if store.get_stage(sess.conn, sess.id, stage) is None:
            raise ValueError(f"gate {gate!r} has not been reached; nothing to edit")
        sess.engine.edit(stage, op)
        return view(sess)
    if not preview_reopen(sess, gate)["reruns"]:    # OV-11: empty blast radius
        sess.engine.edit(stage, op)                 # frontier: v2 path, free
        return view(sess)
    sess.engine.edit(stage, op, rederive=False)     # reopen: defer
    _reopen(sess, gate)
    return view(sess)


def set_voice(sess, *, voice, speed=1.0):
    """Deferred voice/speed change at a reopened Voice gate. Voice has no edit
    handler (it's regenerate-shaped) — mirror api.regenerate's first half
    (backend/session/api.py:50-65) without the re-derive."""
    from pipeline import projects as projects_mod
    from session import job_ctx
    projects_mod.write_voice(job_ctx.REPO_ROOT, sess.id, voice=voice, speed=speed)
    row = store.get_stage(sess.conn, sess.id, "voice")
    store.upsert_stage(sess.conn, sess.id, "voice", status="stale", input_hash=None,
                       output_json=row["output_json"] if row else None, now=_now())
    sess.engine.invalidate("voice")
    _reopen(sess, "voice")
    return view(sess)


def _reopen(sess, gate):
    store.upsert_gate_state(sess.conn, sess.id, gate, "awaiting_approval", now=_now())
    states = store.get_gate_states(sess.conn, sess.id)
    for g in gates.downstream_gates(gate):
        if g in states:                             # only gates already reached
            store.upsert_gate_state(sess.conn, sess.id, g, "stale", now=_now())
```

(`set_voice` note for the builder: the re-derive picks up the new voice because the voice/speed choice is read into `EngineContext` at resume time — the same mechanism `session_voice.apply` relies on at `backend/session_voice.py:64`.)

- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): §4.1 reopen accumulates, Re-approve pays once"`

### Task 7: auto-run end-to-end equals today's run

**Files:**
- Modify: `backend/session/gatekeeper.py` (none expected — proof task)
- Test: `backend/tests/test_session_gatekeeper.py` (extend)

- [ ] **Step 1: Write the failing test:**

```python
def test_auto_run_equals_run_all(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    a = _mk_session(tmp_path, sid="gated")
    gatekeeper.start(a, auto_run=True)
    b = _mk_session(tmp_path, sid="classic")
    b.engine.run_all()
    assert a.engine.ctx.spec_out.read_text() == b.engine.ctx.spec_out.read_text()
    g = store.get_gate_states(a.conn, a.id)
    assert all(g[x]["state"] == "approved" for x in ("script", "voice", "scenes"))
    assert g["assemble"]["state"] == "awaiting_approval"
    assert store.get_session(a.conn, a.id)["auto_run"] == 1
```

(`_mk_session` gives each sid its own `spec_out` path via the `_ctx` factory so the two specs don't collide.)

- [ ] **Step 2: Run** — should PASS if Tasks 4–6 are correct; if it fails, the state machine has a real bug — fix before proceeding (this is PRD §9.M1's "auto-run end-to-end equals today's run" acceptance test).
- [ ] **Step 3: Commit** — `git commit -m "test(v3-m1): auto-run reproduces run_all byte-identically"`

### Task 8: blast-radius preview (`preview_reopen`)

**Files:**
- Modify: `backend/session/gatekeeper.py`
- Test: `backend/tests/test_session_gatekeeper.py` (extend)

- [ ] **Step 1: Write the failing tests:**

```python
def test_preview_reopen_lists_blast_radius(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    assert gatekeeper.preview_reopen(sess, "script") == {
        "gate": "script",
        "reruns": ["voice", "timing", "footage", "assemble"],
        "staleGates": ["voice", "scenes", "assemble"]}
    assert gatekeeper.preview_reopen(sess, "scenes") == {
        "gate": "scenes", "reruns": ["assemble"], "staleGates": ["assemble"]}


def test_preview_reopen_is_readonly(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)
    before = (dict(calls), store.get_gate_states(sess.conn, sess.id))
    gatekeeper.preview_reopen(sess, "script")
    assert (dict(calls), store.get_gate_states(sess.conn, sess.id)) == before
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement:**

```python
def preview_reopen(sess, gate):
    """Read-only blast radius for the §4.1 amber sheet: which stages would
    re-run and which gates go stale. Scene-level pin survival detail lands in
    M5 (overrides tables know the pins); M6 composes the sheet copy."""
    from session import stages as stages_mod
    owned = [s for s, g in gates.GATE_FOR_STAGE.items() if g == gate]
    down = set()
    for s in owned:
        down.update(d for d in stages_mod.downstream(s) if d != "render")
    ran = [s for s in stages_mod.STAGE_ORDER
           if s in down and store.get_stage(sess.conn, sess.id, s) is not None]
    states = store.get_gate_states(sess.conn, sess.id)
    return {"gate": gate,
            "reruns": ran,
            "staleGates": [g for g in gates.downstream_gates(gate) if g in states]}
```

- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): read-only blast-radius preview for the §4.1 sheet"`

### Task 9: mid-flow auto-run toggle + `api.py` wrappers + gate state in `/state`

**Files:**
- Modify: `backend/session/gatekeeper.py`, `backend/session/api.py`, `backend/session_state.py`
- Test: `backend/tests/test_session_gatekeeper.py`, `backend/tests/test_session_api.py`, `backend/tests/test_session_cli.py` (extend)

- [ ] **Step 0: Mid-flow toggle (PRD §4: "toggling mid-flow applies from the next gate").** Failing test first:

```python
def test_auto_run_toggled_mid_flow_cascades_from_next_gate(tmp_path, monkeypatch):
    _fakes(monkeypatch)
    sess = _started(tmp_path, monkeypatch)            # halted at script gate
    gatekeeper.set_auto_run_mode(sess, True)
    gatekeeper.approve(sess, "script")                # cascades: voice → scenes
    g = store.get_gate_states(sess.conn, sess.id)
    assert all(g[x]["state"] == "approved" for x in ("script", "voice", "scenes"))
    assert g["assemble"]["state"] == "awaiting_approval"
```

Implement in `gatekeeper.py`: `set_auto_run_mode(sess, flag)` = `store.set_auto_run(sess.conn, sess.id, flag, now=_now())`; at the END of `approve()` (after `_run_segment`), if the session's `auto_run` is on and `nxt` is in `gates.APPROVABLE` and not approved, recurse: `return approve(sess, nxt, on_stage=on_stage)`. (`start(auto_run=True)`'s loop then collapses to `set_auto_run_mode` + one `approve` — simplify it to stay DRY.) Gates stay navigable afterward via §4.1 — nothing else changes.

- [ ] **Step 0b: The gate-aware seam in `api.edit` (ruling OV-1 — closes the v2 side door).** Failing tests first:

```python
def test_api_edit_routes_gated_sessions_through_gatekeeper(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _at_assemble_gate(tmp_path, monkeypatch)         # gated session
    before = dict(calls)
    api.edit(sess, "script", _edit_beat_op(0, "Via the old route."))
    assert calls == before                                  # deferred, not re-derived
    assert store.get_gate_states(sess.conn, sess.id)["script"]["state"] == "awaiting_approval"


def test_api_edit_ungated_sessions_byte_identical(tmp_path, monkeypatch):
    calls = _fakes(monkeypatch)
    sess = _session_all_done(tmp_path, monkeypatch)         # no gate rows (v2/autopilot)
    api.edit(sess, "script", _edit_beat_op(0, "Classic."))
    assert store.get_stage(sess.conn, sess.id, "assemble")["status"] == "done"  # re-derived
```

Implement: `api.edit` checks `store.get_gate_states(sess.conn, sess.id)` — non-empty ⇒ delegate to `gatekeeper.edit` (gated semantics: frontier/defer per §4.1); empty ⇒ the existing `sess.engine.edit(stage, op)` path, byte-identical. The same seam goes in `session_voice.py::apply`: gate rows present ⇒ `gatekeeper.set_voice` (defer) instead of `api.regenerate` (immediate). **This makes every existing edit CLI/route (`session_edit/script/timing/assemble/voice`) gate-aware at one choke point — no new routes, and the v2 side door for gated sessions is closed.** Rule recorded for M5/M6: gated edits always travel through `api.edit`/`apply`; never call `engine.edit` directly from a CLI.

- [ ] **Step 1: Write the failing tests** — api wrappers delegate (one smoke test using the fakes: `api.gate_start` → `api.gate_view` shows `script: awaiting_approval`); `session_state.py` output gains `"gates"` and `"autoRun"` keys (extend the existing state CLI test to assert both keys present with the right shapes; explicit assertion: a legacy/ungated session returns `gates: {}`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — in `api.py` (thin, mirrors the existing one-liner style):

```python
from session import gatekeeper


def gate_start(sess: Session, *, auto_run=False, on_stage=None):
    return gatekeeper.start(sess, auto_run=auto_run, on_stage=on_stage)


def gate_approve(sess: Session, gate, *, on_stage=None):
    return gatekeeper.approve(sess, gate, on_stage=on_stage)


def gate_edit(sess: Session, stage, op):
    return gatekeeper.edit(sess, stage, op)


def gate_set_voice(sess: Session, *, voice, speed=1.0):
    return gatekeeper.set_voice(sess, voice=voice, speed=speed)


def gate_view(sess: Session):
    return gatekeeper.view(sess)


def gate_set_auto_run(sess: Session, flag: bool):
    return gatekeeper.set_auto_run_mode(sess, flag)


def gate_preview_reopen(sess: Session, gate):
    return gatekeeper.preview_reopen(sess, gate)
```

In `session_state.py`: include `gatekeeper.view(sess)`'s dict under the top-level keys `gates`/`autoRun` of the existing state payload (sessions with no gate rows — every pre-v3 and autopilot session — return `gates: {}`, which the frontend reads as "ungated").

- [ ] **Step 4: Run to verify pass** → PASS, full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): api gate wrappers + gates in /state payload"`

### Task 10: `session_gate.py` CLI + SSE routes

**Files:**
- Create: `backend/session_gate.py`
- Create: `preview/app/api/session/start/route.ts`
- Create: `preview/app/api/session/[id]/approve/route.ts`
- Test: `backend/tests/test_session_cli.py` (extend); TS via `npm run typecheck` in `preview/`

- [ ] **Step 1: Write the failing CLI tests** — pattern from the existing CLI tests in `test_session_cli.py`: invoke the op functions directly on fakes. Assertions: `start` returns `{ok, sid, gates}` with a fresh `v3-…` sid and PROGRESS lines were emitted (capture stdout); `approve` returns the new gate view; `preview_reopen` passes through; unknown gate → `{ok: false, error}` exit 1.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — `backend/session_gate.py` (docstring + shape mirrors `session_voice.py`; PROGRESS line format mirrors `main.py --progress-json` so the route parser is donor-identical):

```python
"""Studio v3 gate CLI — start / approve / state / preview_reopen (PRD §6.1).

Emits PROGRESS lines (one JSON object per stage transition, with elapsed_s on
done) for the SSE interstitial, then ONE final JSON result line on stdout.

Usage:
  python backend/session_gate.py --op start --topic "..." [--auto-run] [--target-length 60]
  python backend/session_gate.py --op approve --sid <id> --gate script|voice|scenes
  python backend/session_gate.py --op state --sid <id>
  python backend/session_gate.py --op preview_reopen --sid <id> --gate <g>
"""
from __future__ import annotations

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # backend/

import json
import uuid
from pipeline import projects as projects_mod
from session import api, job_ctx


def _on_stage(stage, state, elapsed):
    evt = {"type": "stage", "stage": stage, "state": state}
    if elapsed is not None:
        evt["elapsed_s"] = elapsed
    print("PROGRESS " + json.dumps(evt), flush=True)


def start(topic: str, *, auto_run: bool = False) -> dict:
    sid = f"v3-{uuid.uuid4().hex}"
    ctx = job_ctx.build_ctx(topic=topic, sid=sid)
    sess = api.create(job_ctx.SESSIONS_DB, ctx, session_id=sid, topic=topic)
    try:
        # ruling 2A: gated sessions register in the Project Library exactly
        # like autopilot — shared bootstrap helper extracted from main.py
        # :101-109 (project dir + meta; main.py refactors onto it,
        # behavior-identical, pinned by the autopilot golden tests)
        projects_mod.bootstrap(job_ctx.REPO_ROOT, sid, topic=topic)
        view = api.gate_start(sess, auto_run=auto_run, on_stage=_on_stage)
        # sources sidecar once the script segment exists (mirrors main.py:106)
        projects_mod.write_sources(job_ctx.REPO_ROOT, sid,
                                   sess.engine._load_output("script")["script"])
        return {"ok": True, "sid": sid, **view}
    finally:
        api.close(sess)


def approve(sid: str, gate: str, *, voice: str | None = None,
            speed: float = 1.0) -> dict:
    # ruling 3A: the voice gate's approval CARRIES the user's choice — persist
    # it before the segment runs (same write v2's apply makes), so the synth
    # uses the picked voice and every later resume threads it
    if gate == "voice" and voice is not None:
        projects_mod.write_voice(job_ctx.REPO_ROOT, sid, voice=voice, speed=speed)
    sess = _resume(sid)
    try:
        return {"ok": True, "sid": sid, **api.gate_approve(sess, gate, on_stage=_on_stage)}
    finally:
        api.close(sess)


def state(sid: str) -> dict:
    sess = _resume(sid)
    try:
        return {"ok": True, "sid": sid, **api.gate_view(sess)}
    finally:
        api.close(sess)


def preview_reopen(sid: str, gate: str) -> dict:
    sess = _resume(sid)
    try:
        return {"ok": True, "sid": sid, **api.gate_preview_reopen(sess, gate)}
    finally:
        api.close(sess)


def _resume(sid: str):
    from session import store
    conn = store.connect(job_ctx.SESSIONS_DB)
    try:
        row = store.get_session(conn, sid)
        if row is None:
            raise KeyError(f"no session {sid!r}")
        topic = row["topic"]
    finally:
        conn.close()
    # ruling 3A: thread the persisted voice/speed into the context — without
    # this, any re-derive of the voice stage silently reverts to the default
    # voice (the exact mechanism session_voice.py:64 uses)
    stored = projects_mod.read_voice(job_ctx.REPO_ROOT, sid)
    kwargs = {}
    if stored:
        kwargs = {"voice": stored["voice"], "speed": stored["speed"]}
    return api.resume(job_ctx.SESSIONS_DB,
                      job_ctx.build_ctx(topic=topic, sid=sid, **kwargs),
                      session_id=sid)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--op", required=True,
                    choices=["start", "approve", "state", "preview_reopen",
                             "set_auto_run"])
    ap.add_argument("--topic")
    ap.add_argument("--sid")
    ap.add_argument("--gate")
    ap.add_argument("--auto-run", action="store_true")
    ap.add_argument("--voice")                  # voice-gate approve (ruling 3A)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--flag")                   # set_auto_run true|false
    ap.add_argument("--target-length", type=int, default=60)  # threads in M2
    args = ap.parse_args()
    try:
        if args.op == "start":
            if not args.topic:
                raise ValueError("--topic is required for start")
            res = start(args.topic, auto_run=args.auto_run)
        elif args.op == "approve":
            if not args.sid or not args.gate:
                raise ValueError("--sid and --gate are required for approve")
            res = approve(args.sid, args.gate)
        elif args.op == "state":
            if not args.sid:
                raise ValueError("--sid is required for state")
            res = state(args.sid)
        else:
            if not args.sid or not args.gate:
                raise ValueError("--sid and --gate are required for preview_reopen")
            res = preview_reopen(args.sid, args.gate)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
```

(`--target-length` is parsed-but-ignored until M2 threads it; add the argparse arg now so the route contract is stable. Also add a fifth op `set_auto_run` — `--sid` + `--flag true|false` → `api.gate_set_auto_run` — backend-complete in M1; its route/UI wiring is M6-T2.)

Routes: copy `preview/app/api/generate/route.ts`'s spawn-and-stream structure **exactly** (same Python binary resolution, same PROGRESS-line parser, same SSE encoder), with ONE deviation per ruling 4A — single-flight is **keyed by sid** (a module-level `Map<string, true>` shared by start/approve; duplicate concurrent request → 409 `{error: "session busy"}`; the CLI's already-approved `ValueError` remains the sequential backstop). The donor's global flag would falsely serialize unrelated sessions:
- `POST /api/session/start` body `{topic, autoRun?, targetLength?}` → `session_gate.py --op start --topic … [--auto-run]`; **the CLI prints the sid line FIRST** (`PROGRESS {"type":"sid","sid":…}` before any stage runs — design ruling 2: the Topic page navigates to `/video/[sid]/script` immediately and the gate page hosts the interstitial); forward each PROGRESS object as an SSE event; on the final JSON line emit `{type:'done', sid, gates}`.
- `POST /api/session/[id]/approve` body `{gate, voice?, speed?}` → `session_gate.py --op approve --sid <id> --gate <gate> [--voice … --speed …]`; same streaming; final `{type:'done', gates}`.
- **Stage-event vocabulary is `running | done | failed`** (design ruling 5): a stage exception emits `{"type":"stage","stage":s,"state":"failed","error":…}` then the final `{ok:false}` line — the interstitial renders the failed card with ONE Retry that re-posts the same approve (safe via eng ruling 7A's idempotent-forward). M1 test: a raising fake executor produces the failed event and a clean nonzero exit.

`/api/generate` is untouched — the route survives permanently for ungated/autopilot runs (ruling OV-15); only the home PAGE rewires in M6.

- [ ] **Step 4: Verify (ruling 8A — scripted, not ad-hoc).** Backend suite green; `cd preview && npm run typecheck` clean; then create `backend/scripts/gate_flow_e2e.sh` (house precedent: `hook_gate.py` — gates are scripts, not remembered commands) and run it against the dev server:

```bash
#!/usr/bin/env bash
# Gate-flow E2E: start → approve ×3 → state, with jq assertions.
# Standing gate evidence for M1–M6; donor for M7's live cycles.
# Asserts: script gate awaits after start; each approve advances; the voice
# approve carries --voice and the synth voice matches; double-approve while
# busy → 409; reconnect: /state reflects final gates; assemble awaiting at end.
set -euo pipefail
BASE=${BASE:-http://localhost:3100}
SID=$(curl -sN -X POST "$BASE/api/session/start" -H 'content-type: application/json' \
  -d '{"topic":"the water cycle"}' | grep '"type":"done"' | head -1 | sed 's/^data: //' | jq -r .sid)
for GATE in script voice scenes; do
  BODY='{"gate":"'"$GATE"'"}'
  [ "$GATE" = voice ] && BODY='{"gate":"voice","voice":"af_bella","speed":1.0}'
  curl -sN -X POST "$BASE/api/session/$SID/approve" -H 'content-type: application/json' \
    -d "$BODY" | tail -1 | grep -q '"type":"done"'
done
STATE=$(curl -s "$BASE/api/session/$SID/state")
echo "$STATE" | jq -e '.gates.script.state=="approved" and .gates.voice.state=="approved"
  and .gates.scenes.state=="approved" and .gates.assemble.state=="awaiting_approval"' >/dev/null
# double-approve guard (4A): an already-approved gate with its next gate open → clean error
curl -s -X POST "$BASE/api/session/$SID/approve" -d '{"gate":"script"}' | grep -qi 'error\|409'
echo "GATE FLOW E2E: PASS ($SID)"
```

- [ ] **Step 5: Commit** — `git commit -m "feat(v3-m1): session_gate CLI + start/approve SSE routes"`

**M1 exit gate:** full backend suite green; `tsc` ×3 clean; the curl E2E transcript + `test_auto_run_equals_run_all` are the gate evidence. Operator reviews before M2 opens.

---

## M2 — Length presets (scoped; expand when slot opens)

Maps: PRD §5.0, §6.4, §7, D1-B, D3. Gate: per-preset beat-band tests (mocked LLM) green; segment byte tests green; default-preset prompt golden-bytes test green; caps math + bulk-edit cap tests green.

- **T1 — SYSTEM_PROMPT segment surgery (its own commit, PRD §7).** `backend/pipeline/script.py:28-66`: split the frozen literal into named module segments — the two length sentences (`script.py:29` "~60-90s", `script.py:34` "Produce 5-8 beats") become a parametrized block; the ① keyword-rule segment (`script.py:47-61`) and grounding segment (`script.py:62-65`) become `KEYWORD_RULE_SEGMENT` / `GROUNDING_SEGMENT` constants concatenated back. Add `LENGTH_PRESETS = {30: …, 60: …, 180: …, 300: …}` (beat bands 5–6 / **5–8** / 22–30 / 38–48; words-per-beat 8–18 one sentence vs 15–45 two-to-three sentences. **Ruling OV-3 amends PRD §5.0's 60s band from 7–9 to 5–8:** the frozen prompt says "Produce 5-8 beats" and D1-B pins its bytes — a 7–9 band would flag every legitimate default-preset script and burn the bounded retry; the PRD's 7–9 is a drafting artifact) and `system_prompt_for(target_length: int) -> str`. **Golden test:** `system_prompt_for(60) == SYSTEM_PROMPT` byte-identical to today's bytes (capture the literal in the test before refactoring). **Segment tests** (the D1-B surgery on `test_studio_script_gate.py:88-97`): `KEYWORD_RULE_SEGMENT in system_prompt_for(p)` and `GROUNDING_SEGMENT in system_prompt_for(p)` for all four presets, byte-identical across presets; the old whole-string guard is replaced, not weakened — the style-memory seam test (`test_style_memory_block_alters_a_prompt`) stays.
- **T2 — `target_length` threading.** `sessions.target_length INTEGER NOT NULL DEFAULT 60` via the Task-1 `_migrate()` helper; `EngineContext.target_length: int = 60` (`backend/session/executors.py:22-38`); `run_script` (`executors.py:41-54`) calls `system_prompt_for(ctx.target_length)`; `job_ctx.build_ctx` + `api.create` + `session_gate.py --target-length` thread it. Note: `Engine._input_hash` (`engine.py:68-76`) hashes only topic+fps+inputs — add `target_length` to the hash payload so changing the preset invalidates the script cache (test this).
- **T3 — band validation + one bounded retry (PRD §11 risk, extended per ruling OV-8).** In `run_script`: if the returned beat count is outside the preset band, ONE retry with an appended corrective user line; if still outside, return as-is and record `band_miss` in the script bundle for the gate header to surface honestly. **The same retry also catches truncated/malformed JSON** — at 38–48 beats a single completion risks output-token truncation, and a parse failure must burn the retry then surface honestly, never crash the stage. Tests with mocked LLM returning wrong-then-right counts AND truncated-then-valid JSON.
- **T4 — named verify caps + scaling.** `backend/pipeline/verify.py`: promote `max_targeted=3` (`verify.py:51`) to `MAX_TARGETED_BASE = 3`; scale by `ceil(beats/8)` at the `verify_script` call site. Add `EDIT_RECHECK_MAX_TAVILY = 4`: `verify_edited_beats` (`verify.py:109-152`) caps retrieval to the first 4 edited indices per save burst; overflow beats get flag `{"status": "unverified", "reason": "recheck skipped (cap) — re-save to recheck"}` rather than silently passing. Tests: caps math at 8/9/30/48 beats; a 6-index bulk edit fires exactly 4 retrievals and flags 2.

⚠️ M2 must not touch `multi-sentence` validation — `Beat.text` already permits multi-sentence (`backend/pipeline/content.py:17-38` validates non-empty only); karaoke captions are word-timed and unaffected (PRD §6.4).

---

## M3 — Voice previews on the user's beats (scoped; expand when slot opens)

Maps: PRD §5.2, §6.1 voice-preview bullet, §9.M3. Gate: cache-hit + threading tests green; route passthrough proven with curl.

- **T1 — retarget `preview()`** (`backend/session_voice.py:50-57`): accept optional `sid`; when given, read the session's script beat 1 and synthesize its first ~12 words (split on whitespace, join ≤12 tokens) instead of `SAMPLE_LINE`; cache filename becomes `voice_preview_{voice}_{text_hash}_{speed}.wav` where `text_hash = sha1(text)[:12]`. No sid → canned-line fallback (today's behavior, keeps the route backward-compatible). Tests (monkeypatched `tts_stage.synthesize` with a call counter): same `(voice, text, speed)` synthesizes once; different speed or edited beat text (new hash) synthesizes again; invalid voice still rejects.
- **T2 — CLI/route threading:** `session_voice.py` argparse already has `--sid` — pass it into `preview()`; `preview/app/api/session/[id]/voice/route.ts` already posts the sid path param — verify it forwards (likely zero TS change; prove with curl: two identical preview calls, second returns instantly with the same path).
- **Zero LLM cost invariant** (PRD §6.1): preview must never call DeepSeek/Tavily — test asserts only `tts.synthesize` was invoked.

---

## M4 — Hero background contract + renderer (scoped; expand when slot opens)

Maps: PRD §6.2, §9.M4. Gate: lockstep schema tests both sides; suppression/boundary suite untouched and green; contrast gate stills approved eyes-on; vitest + `tsc` ×3 green.

- **T1 — contract migration (small, isolated, its own commit).** New `templates/mediaSchema.ts`: a zod object mirroring `Media` **verbatim** (`backend/schema.py:43-49` ↔ `remotion/src/schema.ts:36-44`): `{type: 'video'|'image', src: string, fit: 'cover'|'contain', kenBurns?: {from,to,originX,originY}|null, loop?: boolean}`, `.strict()`. Add `backgroundClip: mediaSchema.optional()` to `templates/hook/schema.ts`, `templates/stat/schema.ts`, `templates/outro/schema.ts` (all currently `.strict()` two-field objects). Re-run `templates/scripts/gen-manifests.ts` → `inputSchema` regenerates → `validate.py::_check_props` (`backend/pipeline/validate.py:42-46`) accepts hero props with `backgroundClip` and still rejects unknown keys. **Tests both sides:** Python — a hero scene spec with `backgroundClip` validates (Pydantic `Spec` + jsonschema), `duration`/`durationInFrames` inside `backgroundClip` rejected (no duration on media — PRD §6.2); TS — `z.infer` types compile, registry byte-stable on unchanged inputs.
- **T2 — whitelist regression test (no code change — ground-truth delta #1).** `backend/tests/test_spec_patch.py` (extend): `scenes/1/templateProps/backgroundClip` and `…/backgroundClip/src` pass `check_path`; post-apply `Spec.model_validate` accepts the patched spec; `scenes/1/durationInFrames` still rejects.
- **T3 — `HeroBackdrop` shared layer + the three Components.** New `templates/HeroBackdrop.tsx`: renders the §6.2 stack — muted clip (`OffthreadVideo` with `loop` / `Img` with kenBurns, reusing the wrapper-AbsoluteFill idiom from `templates/scene/Component.tsx:28-60` — transform on the wrapper, never the video element) → dark scrim (flat `rgba(0,0,0,…)` layer) → `heroBackground(theme.palette, frame/HERO_BREATH_PERIOD)` painted above as glow — **the same gradient string in both modes, do not fork `heroBackground.ts`** (with no clip the gradient layer is all there is = today's opaque card; with a clip it sits over the scrim as the radial glow). Wire into `hook/Component.tsx` (gradient at line 63), `stat/Component.tsx` (line 54), `outro/Component.tsx` (line 27): replace the inline `background:` with `<HeroBackdrop clip={data.backgroundClip} …>`. Vitest: no-clip output structurally identical to today (the gradient string for phase 0 is byte-equal); with-clip output contains a scrim layer with alpha within the contrast budget; `rendersOwnText` stays true in all three manifests (captions stay suppressed — run `remotion/src/captions-suppress.test.ts` untouched).
- **T4 — contrast + loop gates.** New `backend/scripts/hero_bg_gate.py` (donor: `backend/scripts/hook_gate.py:135-165` — `npx remotion still` → PNG): render a hook frame with a busy test clip + with no clip. **Metric per ruling OV-7 — worst-case LOCAL contrast, not mean:** tile the text region, compute per-tile text/background contrast, assert the MINIMUM tile ≥ the gradient-only baseline. (Mean luminance is vacuous: any scrim lowers the mean while busy mid-tone texture destroys local legibility without moving it — the mean version can never fail.) Loop math: backgroundClip uses the existing `_scene_media` computation (`backend/pipeline/assemble.py:71-77`) when M5 injects it — write the unit test here against `_scene_media` directly (clip shorter than span → `loop=True`; scene `durationInFrames` unchanged), so M4 closes self-contained.

---

## M5 — Pools for all beats · auto-fill policy · overrides · ②b pick log · gate ops (scoped; expand when slot opens)

Maps: PRD §6.1 (pools bullet), §6.3, §6.5, §5.3.2/.3, D4, §9.M5. Gate: the five PRD §9.M5 tests green; curl E2E for the new ops; state payload carries eligibility + hero pools + background provenance.

- **T1 — hero query wiring + pools for ALL beats (D4).** `backend/pipeline/recipe.py`: hero `PlannedScene`s (`recipe.py:58-65`, planned at lines 159/161/163) keep `needs_footage=False` but gain `query = harden(beat.keywords or topic_title, title=topic_title)` — the title fallback is **mandatory** (`Beat.keywords` is Optional and unenforced, `content.py:22`). Footage executor fetches a ranked pool (`per_page=15`, `footage.py:112`) for every scene with a query — heroes included — stored in `footage_candidates` unchanged (keyed by scene_index; ground-truth delta #5: no schema change). Nothing downloads until picked/auto-applied. **Quota, not latency, is the binding constraint (ruling OV-6):** 38–48 searches per 5-min video against Pexels' ~200 req/hr free tier ≈ 4 videos/hour. Mitigations: (a) a per-hardened-query pool cache (same idiom as the `.cache/retrieval` Tavily cache) so repeated queries cost zero calls; (b) batch with backoff for 429 spikes; (c) quota exhaustion surfaces HONESTLY at the gate ("pool fetch hit the rate limit — retry in N min"), never as a raw stage failure. **Tests:** a keyword-less hero beat still gets a pool (query == title); a rate-limited response retries; a cached query makes zero network calls; exhaustion produces the surfaced error state.
- **T2 — auto-fill policy (PRD §6.3, deterministic, same in auto-run).** `HERO_BACKGROUND_POLICY = {"hook": "auto", "outro": "auto", "stat": "gradient"}` as a constant in **`backend/pipeline/footage.py`** — ruling OV-5 amends PRD §6.3's "constant in main.py": `main.py` imports `pipeline.tts` (torch) at module level, and `job_ctx.py` exists precisely to keep fast CLIs free of that import; policy-as-data lives next to its mechanism instead. Hook/outro: `select_clip` **including the K-floor** (`footage.py:80-97` — zero special-casing, PRD ruling) picks rank-1 → download-on-apply → `background_overrides` row `{scene_index, value: clip, source: "auto", picked_rank: 1}`; stat: pool fetched, no application. **Write path per ruling OV-4:** the auto-fill rows are written by an **engine post-advance hook** on `advance("footage")` — the exact precedent of `_sync_footage_candidates_to_db` (`engine.py:95-103`) — because executors are `(ctx, inputs)`-pure and never see the DB. **Tests:** stat default = gradient (no override row, no download); hook auto = rank 1 via the K-floor path (a short rank-1 yields the K-floor's longer pick, proving the shared path).
- **T3 — overrides tables.** `store.py`: `template_overrides` + `background_overrides`, both `{session_id, scene_index, value TEXT (JSON), source TEXT CHECK(auto|pinned), picked_rank INTEGER NULL, updated_at, PK(session_id, scene_index)}` + upsert/get helpers + tests; all three M5 tables join `delete_session` and the 5A all-tables zero-rows test covers them automatically. (Rides the `store.py` lane after M2's column.)
- **T4 — ②b append-only pick log (NEW work — `upsert_provenance` overwrites and stays as-is, `store.py:211-223`).** `pick_log` table: `{session_id, seq, scene_index, kind CHECK(footage|background), query, auto_rank, human_rank, ts}` — `seq` uses the **`MAX(seq)+1`-per-session-in-a-transaction idiom from `spec_patches` (`store.py:178-180`)**, NOT SQLite `AUTOINCREMENT` (which is table-global — ruling OV-14 wording fix). `ts` is a **real timestamp stamped at the CLI boundary** (ruling OV-9: `engine._now()` returns a fixed token by design; the pick log is ②b *evidence* and needs genuine time; CLIs run outside the argless-now sandbox constraint). Append on every pick (footage AND background, PRD §6.5) alongside the provenance upsert. **Test:** after a pick, provenance shows the pick but the log row preserves `auto_rank` (the ②b revisit evidence).
- **T5 — assemble consumes overrides (read path per ruling OV-4).** Executors stay `(ctx, inputs)`-pure: the **engine reads both overrides tables before `advance("assemble")` and injects them into the assemble `inputs` dict** (a new `overrides` input key) — which means they **participate in `_input_hash`**, so changing an override correctly invalidates the assemble cache and a pin survives re-derives only while unchanged (the existing caching contract, for free). `backend/pipeline/assemble.py::build_spec` (hero branch at line 113 `props = dict(ps.props)`): inject `props["backgroundClip"] = _scene_media(bg_clip, dur_i + t_frames).model_dump(by_alias=True)` when a background override/auto row exists; apply `template_overrides` to `ps.template` (re-validated against eligibility). `backend/session/executors.py` and `engine.py` join the M5 file map for this seam. **Tests:** override consumed by assemble (PRD §9.M5); override change invalidates the assemble hash; loop math flows through `_scene_media` (M4-T4's unit test covers the math).
- **T6 — gate ops.** Extend `_edit_footage` (`engine.py:275-339`) with `target: "background"` on pick/re_query/upload for hero scenes (writes `background_overrides` + pick log + provenance; upload reuses `_upload_footage` staging); add `{"op": "re_query", "broaden": true}` → query = title (the gate-op form of the autopilot whiff-fallback at `footage.py:218-228`); add `{"op": "pick_template", "template": id}` writing `template_overrides` (eligibility-checked). CLI (`session_edit.py`) + route (`preview/app/api/session/[id]/edit/route.ts`) gain the new args. Transitions need no new op — `scenes[i].transition` is already patch-whitelisted (`spec_patch.py:24`).
- **T7 — eligibility + state surface.** Per-scene eligible templates computed from `_derive_role` (`recipe.py:124-130`) + kind gating + `inputSchema` data requirements (`stat` needs `data{value,label}`, `enumeration` needs `data{items}` — live-eligible day one, PRD §5.3.1); exposed in `session_state.py` per scene: `{eligibleTemplates, templateOverride, backgroundPool, backgroundProvenance, pickLogCount}`. **Test:** state shape; enumeration eligible for a beat with `data.items`.

---

## M6 — Frontend (scoped; expand when slot opens — task-level breakdown below is the expansion's skeleton)

Maps: PRD §4.1, §5.0–5.4, §8, §9.M6. Visual sources of truth: the rev-2 mock + **the approved §4.1 wireframe** (`~/.gstack/projects/AIVideoGenerationTool/designs/blast-radius-sheet-20260612/wireframe.html`, ruling trail in `approved.json`). Gate: vitest + `tsc` ×3 green; in-browser eyes-on per the M7 artifact list; a11y checklist (PRD §9.M6) verified in DOM.

### M6 design contract (design-review rulings, 2026-06-12 — normative for every task below)

- **Amber tokens (ruling 16):** add `--warn` + `--warn-soft` to `globals.css`; amber is carried by ICONS, PILLS, and the Re-approve BUTTON — **never border strips** (slop-blacklist adjacency); the stale-dot glow collapses under `prefers-reduced-motion` (ratifications §4 discipline).
- **§4.1 surfaces (rulings D2/D3, wireframe-approved):** blast-radius sheet = **hybrid** — task CHIPS (same vocabulary as the interstitial card, promise→payment traceability) + per-scene **pin-fate rows rendered only when pins are at stake**, per-task time estimates as chip subtext; stepper carries amber glowing stale dots on downstream pips; the reopened gate's tinted action swaps to an **amber Re-approve** with subtitle "runs N stale steps once" (one-tinted-action = count discipline, not hue).
- **Edit-intent table (ruling from OV-7):** beat textarea = sheet on Save; pool tile / template chip / voice card = sheet on click with the POST withheld; **Cancel discards local state — zero backend traffic** (matches the gatekeeper docstring).
- **Interaction state table (Pass 2):**

| Surface | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL/STALE |
|---|---|---|---|---|---|
| Interstitial | per-stage card, ticking elapsed + per-preset leave-copy ("~N min — one pool per beat; you can leave, it keeps building") | — | **failed card** + verbatim backend error + ONE Retry (re-posts approve) | auto-advance to the opened gate | **reconnected mode**: `/state` signature (gate approved + next row missing) → interstitial polls `/state`; 409 → same view + toast |
| Gate pages | skeleton on `/state` fetch | — | route error toast | stateful stamp | **LOCKED** = quiet card "Approve Voice to build scenes" linking the frontier (rail suppressed pre-spec); **STALE** = view-only, edits disabled, amber banner naming the reopened gate with link |
| Scene pool strip | tile skeletons | "no clips found for '<query>' — broaden to the topic title or upload your own" + Suggest/Re-query(broaden)/Upload row | quota: inline "pool fetch hit the rate limit — retry in N min" + countdown-disabled Retry | rank badges, auto tag | pending-pick: amber ring + "pending · applies on Re-approve" pill, player intentionally on old clip |
| Script gate header | — | — | **band_miss warn pill**: "asked for 22–30 beats, got 19 — regenerate or approve as-is" | credibility badge | reopened stamp |
| Recents/hub card | "building" state while a segment runs | — | **"draft — script failed"** dimmed card + Retry (re-enters the script segment) + Delete | normal | stale dot mirror |

- **Arrival moment (ruling 12):** scenes gate opens with ALL rows collapsed; the rail auto-plays the full first assembly ONCE from frame 0 (mobile: PiP carries it); one-time eyebrow "first assembly ready — every scene is editable below". The celebration is the video itself — no modal, no confetti.
- **Post-Re-approve landing (ruling 4):** stay on the reopened gate with its restored stamp; toast links the frontier ("Rebuilt — Assemble is ready →"); never auto-navigate.
- **Status pills (ruling 15):** TWO slots per collapsed row — MEDIA (`auto/pinned/re-queried/uploaded/gradient/bg auto/bg pinned`, precedence pinned > uploaded > re-queried > auto) + TEMPLATE (only when overridden); tones reuse the `ProvenanceBadges` map (uploaded stays green).
- **Sheet a11y (ruling 17):** centered glass dialog ≥sm, **bottom sheet below sm**; focus trap with initial focus on Cancel (the amber action is the costly one); ESC = Cancel; interstitial task card `aria-live=polite` announcing stage transitions only (never elapsed ticks); accordion chevron rows ≥44px touch targets.

- **T1 — Topic screen** (`preview/app/page.tsx`): length preset chips (30 s default-60 s 3 min 5 min, hint line with beat target per §5.0), auto-run toggle (consequence label per ruling 14); Generate posts to `/api/session/start` SSE and **navigates to `/video/[sid]/script` on the sid-first event** (ruling 2) — the gate page hosts the interstitial. Failed start renders the "draft — script failed" Recents/hub state (ruling 8). **The home PAGE rewires here; the `/api/generate` ROUTE survives permanently for ungated/autopilot runs and QA scripts (ruling OV-15).**
- **T2 — Stepper bar + interstitial task card:** floating glass bar (Topic ✦ → 1 Script → 2 Voice → 3 Scenes → 4 Assemble; completed navigable, pending `aria-disabled`, amber stale dots from `/state` gates); auto-run toggle lives on the bar too (§4 — wired to M1's `set_auto_run` op via a small JSON route; mid-flow flip applies from the next gate; toggle ON relabels the gate action "Approve & run all", ruling 14); in-pane interstitial consuming the SSE `{type:'stage', stage, state, elapsed_s}` events — real tasks, real timings (§4 "honesty is a feature"), plus the design-contract states: **failed card + Retry** (ruling 5), **reconnected mode** (ruling 6), **LOCKED/STALE shared page states** (ruling 7), **ticking elapsed + leave-copy + hub "building" state** (ruling 13), `aria-live=polite` (ruling 17). Honest time expectations for long presets (§6.4: 50 beats = 50 pools). Timing stays not-a-gate: the hub-level timing explainer survives as a row on the video page (§4).
- **T3 — Script gate reshaped** (`app/video/[id]/script/page.tsx`): v2 behavior repositioned (§5.1 — beat cards, inline edit + flag-only re-verify, drop beat, feedback chips + regenerate, style memory untouched); header gains the **stateful stamp** (§4.1.1: pre-approval "nothing downstream has run yet" / post-approval "approved — downstream builds from script vN · editing reopens this gate"); credibility badge in the stamp + the **band_miss warn pill** with its verbatim copy (ruling 9).
- **T4 — Voice gate** (`app/video/[id]/voice/page.tsx`): cards play **your beat 1** via the M3 preview op (♪ on demand, spinner while synth); speed slider 0.8–1.2× with the re-times-everything note; gate copy replaced per ruling 18: "Approve locks the voice, then builds narration, timing, footage, and a first assembly — a few minutes" (the v2 "footage picks are kept" line is FALSE here and must not survive); Approve = the gate's one tinted action → `/approve {gate:'voice', voice, speed}` SSE → heavy interstitial.
- **T5 — Scenes gate accordion** (new `app/video/[id]/scenes/page.tsx` replacing `/footage`; route file deleted, redirect added): one row per scene, ONE open at a time; collapsed row = index · kind chip · truncated beat · duration · **two status-pill slots per ruling 15** (MEDIA + TEMPLATE, precedence + tones per the design contract — derived from overrides + provenance, never stored) · chevron; arrival state per ruling 12 (all collapsed, rail plays once, one-time eyebrow); collapsed bodies `display:none` + `inert` (PRD §9.M6 a11y — the mock's ARIA-tree gap); keyboard semantics on tiles and play targets.
- **T6 — Per-scene player + mount budget:** one `@remotion/player` in the open row bound via `inFrame`/`outFrame` to the scene's span on the live spec, looping within the span; **desktop:** rail auto-pauses while the scene player plays; **mobile:** `MobilePiP` **unmounts** while a row is open (lift open-row state into the `/video/[id]` layout context — `layout.tsx:1-32` currently always-mounts both, ground truth §5.3) and restores on collapse. Never more than two mounted — assert with a vitest on the layout logic.
- **T7 — Scenes controls column:** template chips (eligible-only from state, AI pick tagged `auto`, pick = pin via `pick_template`); footage pool (rank badges, rank 1 = `auto`, "you're the rerank"); background pool with **tile 0 = the gradient floor** (explicitly pickable) + policy label ("AI picked #1 · topic is filmable" / "AI kept the gradient — abstract beat"); Suggest (existing `/footage/suggest`) / Re-query (broaden=title) / Upload row; **empty-pool + quota states per the design contract** (rulings 10/11); provenance badge popover surfaces the pick log ("3 picks on this scene" + last auto→human rank pair — ruling 19); transition chips (fade/slide/none via the patch path); under-player strip: `frames a–b · n.n s`, verify chip, Fix-a-word (`_edit_timing`), captions state ("on" / "suppressed (hero)").
- **T8 — Assemble gate slimmed** (`app/video/[id]/assemble/page.tsx`): per-scene controls REMOVED (they live in Scenes; the chat whitelist still patches them, §5.4); theme cards (Ember flips rail live — `body.ember` sibling-layer mechanism per the PRD-review correction), director chat + history/revert as in v2; Render with progress; done-state demotes the Render bar to a single tinted CTA (mock rev-2 done state).
- **T9 — §4.1 reopen pattern:** stateful stamps everywhere (T3's pattern generalized — note per ruling OV-9: gate stamps are stateful TEXT, not timestamps; `approved_at` is a truthiness token); **blast-radius sheet on first edit intent** at a completed gate — amber-accented glass sheet fed by `preview_reopen` (reruns + staleGates + M5 pin detail), Buttons Reopen/Cancel (Cancel reverts the local edit, backend untouched); after Reopen, edits accumulate silently; the gate's tinted action becomes **Re-approve** → ONE `/approve` SSE interstitial. **Pending-pick affordance (ruling OV-12):** at a reopened Scenes gate a picked tile shows "pending · applies on Re-approve" (ring + status pill flips to pinned-pending) and the per-scene player intentionally keeps the old clip — deferral skips `materialize_spec` by design; the affordance makes the one-payment rule legible instead of looking broken. Render-done projects follow the same pattern (done state is not special).
- **T10 — Responsive + a11y pass:** accordion stacks on mobile (player above controls per the mock); PiP pattern unchanged elsewhere; one tinted action per screen audit (Generate / Approve ×3 / Render); keyboard + SR labels on pool tiles, voice play buttons, stepper steps; sheet bottom-sheet-below-sm + focus/ESC contract + ≥44px chevron targets (ruling 17).
- **T11 — Hub + GateHeader (ruling 3 — previously unowned):** `/video/[id]` gate cards speak v3 states (locked/stale/approved/building), Footage card → Scenes, the timing-explainer row lands here; `preview/components/GateHeader.tsx:8` `CHAIN` → `[script, voice, scenes, assemble]` with the Next→ link gated on gate state (`aria-disabled` when unreached); post-Re-approve stays on the reopened gate + frontier toast (ruling 4).

---

## M7 — Reviewer gates (motion is the standing artifact)

Maps: PRD §9.M7, D3. **Gate: operator pixel/motion review — nothing merges before it.**

- **T1 — Motion artifacts** uploaded to `/mnt/user-data/uploads/`: (a) gate→interstitial→gate transition; (b) accordion open + per-scene player playing its span; (c) hero card with background in motion + gradient fallback side-by-side; (d) theme flip propagating to rail + hero glows. Short MP4s or dense frame strips; measure motion by cycle amplitude, not adjacent-frame delta (house rule).
- **T2 — Live cycles:** one full real-topic cycle at 60 s and one at 3 min, render checked end-to-end. **The 3-min pass un-gates the 3-min chip (D3, unchanged).** Per ruling OV-8, a 5-min cycle is added as a SHOULD (runs if the 3-min cycle passes) — **the 5-min chip stays gated until its OWN cycle passes**, since 38–48 beats is where output-token truncation bites and 3-min evidence doesn't transfer.

---

## File structure map (new/modified, by milestone)

| File | M | Change |
|---|---|---|
| `backend/session/store.py` | M1, M2, M5 | `gates` table + `auto_run` + `_migrate()`; `target_length`; `template_overrides`/`background_overrides`/`pick_log` |
| `backend/session/gates.py` | M1 | NEW — gate topology |
| `backend/session/gatekeeper.py` | M1 | NEW — state machine (start/approve/edit/set_voice/preview_reopen/view) |
| `backend/session/engine.py` | M1, M5 | `edit(rederive=)` + `rederive_stale()`; background/template gate ops |
| `backend/session/api.py` | M1 | gate wrappers |
| `backend/session_gate.py` | M1 | NEW — CLI |
| `backend/scripts/gate_flow_e2e.sh` | M1 | NEW — scripted gate-flow E2E (ruling 8A) |
| `backend/pipeline/projects.py` | M1 | `bootstrap()` + `write_sources()` helpers; `main.py` refactors onto them (ruling 2A) |
| `backend/main.py` | M1 | bootstrap extraction (behavior-identical, golden-pinned) |
| `backend/session_state.py` | M1, M5 | gates+autoRun; eligibility + hero pools surface |
| `preview/app/api/session/start/route.ts` | M1 | NEW — SSE |
| `preview/app/api/session/[id]/approve/route.ts` | M1 | NEW — SSE |
| `backend/pipeline/script.py` | M2 | segment constants + `LENGTH_PRESETS` + `system_prompt_for` |
| `backend/pipeline/verify.py` | M2 | `MAX_TARGETED_BASE` scaling + `EDIT_RECHECK_MAX_TAVILY` |
| `backend/session/executors.py` | M2 | `EngineContext.target_length` + threading |
| `backend/tests/test_studio_script_gate.py` | M2 | D1-B segment-test surgery |
| `backend/session_voice.py` | M3 | beat-1 preview + `(voice, text_hash, speed)` cache |
| `templates/mediaSchema.ts` | M4 | NEW — zod Media mirror |
| `templates/{hook,stat,outro}/schema.ts` + manifests | M4 | `backgroundClip` optional |
| `templates/HeroBackdrop.tsx` | M4 | NEW — clip→scrim→glow→text stack |
| `templates/{hook,stat,outro}/Component.tsx` | M4 | use HeroBackdrop |
| `backend/scripts/hero_bg_gate.py` | M4 | NEW — contrast render gate |
| `backend/pipeline/recipe.py` | M5 | hero query wiring (D4) |
| `backend/pipeline/footage.py` | M5 | pools for all beats + query-level pool cache + `HERO_BACKGROUND_POLICY` (ruling OV-5: NOT main.py) |
| `backend/session/engine.py` + `executors.py` | M5 | post-advance auto-fill hook; overrides join assemble inputs/hash (ruling OV-4) |
| `backend/pipeline/assemble.py` | M5 | overrides + backgroundClip injection |
| `backend/session_edit.py` + edit route | M5 | background/template/broaden ops |
| `preview/app/**` (T1–T10) | M6 | per the M6 breakdown |

## Acceptance traceability (PRD §12 → milestone)

| §12 criterion | Proven by |
|---|---|
| Read/regenerate script with zero downstream work; approve visibly starts next segment | M1 (halt/approve/SSE tests + curl E2E), M6-T2/T3 |
| Voice cards play YOUR beat 1 locally; approve runs synth+timing+pools | M3, M1 (scenes segment), M6-T4 |
| Every scene editable from one row; instant spec-only preview; ≤2 players counting MobilePiP | M6-T5/T6/T7 (+ M5 ops) |
| Hook/Outro default dimmed rank-1 clip, legible; Stat gradient + pool ready; tile 0 gradient; suppression/audio untouched | M4, M5-T1/T2, M6-T7; suppression suite green every milestone |
| Presets produce beat-band scripts; named scaling caps; edit recheck capped; no hard duration limit | M2 |
| Auto-run reproduces today's one-shot incl. conservative hero policy | M1-T7 + M5-T2 (policy is the same code path) |
| Back-nav view-only + stateful stamp; sheet on first edit intent; ONE re-derive on Re-approve | M1-T6/T8 (backend), M6-T9 (UI) |
| Phase-2/3 + suppress-boundary + frozen-①-segment tests stay green | every milestone's exit gate runs the full suites |

---

*Plan written 2026-06-12 from PRD rev 2.1 + a 5-agent ground-truth pass over `development` (deltas §above). Eng review completed same day — 23 findings ruled and folded inline (see report below). `/plan-design-review` is the remaining lock step; build M1 after.*

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| §4.1 blast-radius sheet + stepper stale states + pending-pick tile | `~/.gstack/projects/AIVideoGenerationTool/designs/blast-radius-sheet-20260612/wireframe.html` (+ `approved.json` ruling trail) | **Hybrid**: panel B's task chips + panel C's pin-fate rows (rendered only when pins are at stake), panel A's time estimates as chip subtext; amber Re-approve button + glowing stale dots per panel 0; pending-pick tile per panel P | Amber via icons/pills/button — never border strips (ruling 16); bottom sheet below `sm`; focus lands on Cancel; all other M6 surfaces follow the operator-approved rev-2 mock (`~/Downloads/studio-v3-staged-flow-mock (1).html`) |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — (scope operator-ruled in the PRD review) |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | ABSORBED | eng outside voice: 15 findings (14 accepted, 1 rejected — OV-10 counterexample); design outside voice [single-model]: 18 findings, all ruled |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 23 issues (4 arch, 2 code-quality, 2 test, 0 perf, 15 outside-voice), 0 critical gaps, all folded inline |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score 7/10 → 9/10; 21 decisions (D2/D3 wireframe rulings + 19 pass rulings) folded into the M6 design contract; SSE contract gains sid-first/failed/real-rederive events in M1 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** both outside voices ran as fresh-context Claude subagents (codex CLI absent). Eng headline catches: gated-edit transport seam, 60s band contradiction, overrides plumbing, quota math, vacuous contrast gate. Design headline catches: the synthetic "rederive" card contradicting honesty-is-a-feature, the homeless start wait, missing failed/reconnect/locked/stale states, the unowned hub + hardcoded GateHeader CHAIN.
- **CROSS-MODEL:** one genuine tension across both reviews — OV-10 (derived staleness vs stored 3-state), resolved for stored state via the reopen-attribution counterexample, documented in `gates.py`'s design note.
- **VERDICT:** ENG + DESIGN CLEARED — plan locked; M1 builds on `studio-v3-staged-flow` off `development` (M7 eyes-on remains the standing pixel gate).

NO UNRESOLVED DECISIONS

---

## M1 BUILD AMENDMENTS (2026-06-13 — ruled during the build; M2–M7 expansions must honor these)

M1 shipped on `studio-v3-staged-flow` (Tasks 1–10, ~30 commits): 392 backend tests green, `tsc` ×3 clean, vitest green (preview 23, remotion 104), live curl E2E PASS on the real pipeline (`gate_flow_e2e.sh`, sid `v3-99188d4c…`: start → script gate → approve ×3 incl. voice-carry → assemble awaiting; double-approve → clean error). Deviations from the plan's prescribed code, each ruled and test-pinned:

1. **`gatekeeper.edit` dispatches by the OWNING GATE'S STATE, not blast-radius emptiness alone** (amends Task 6's prescribed body). The plan's form broke two of its own rulings: a timing/footage edit at the AWAITING scenes gate deferred with no payment path (approve("scenes") sees no stale gates → assemble stage stale forever, spec.json lagging), and an edit at a STALE gate flipped it to awaiting (two open gates). Final dispatch: gate row missing+stage ran → v2 path; STALE → ValueError naming the reopened gate (M6 view-only backstop); APPROVED or REOPENED (awaiting WITH approved_at) → §4.1 defer+reopen (or OV-11 free when nothing downstream ran); TRUE FRONTIER (awaiting, no stamp) → instant via `rederive_stale()` (re-derives only ran-stages — never advances past a gate) + explicit materialize for assemble. All 8 arms test-pinned. The reopened-vs-frontier discriminator is `approved_at` on an awaiting gate.
2. **Gated regenerate sealed (OV-1 completion).** `session_script.py`'s regenerate was a residual side door (would advance a gated session past its gates). `gatekeeper.regenerate(stage)` re-runs the stage NOW (gate page needs the fresh output) then routes downstream by the same dispatch as edit; `api.regenerate` gained the same gate-rows seam as `api.edit`. set_voice also gained the stale view-only guard (holistic-review catch: it could mint a second awaiting gate).
3. **`preview_reopen` was forward-ported into Task 6** (edit() depends on it); plan-Task-8 became tests-only. Implementation is plan-verbatim.
4. **`main.py` bootstraps the Project Library at RUN START** (stub meta {id, topic, createdAt}; `write_meta` overwrites on success). Final artifacts byte-identical (golden tests pin sources.json + the sidecar builder). New user-visible artifact: a failed/in-flight run leaves a stub project — this is exactly what M6's hub "building" / "draft — script failed" cards consume (ruling 8/13). M6-T11 must handle title-less stub metas in the Library list.
5. **`/state` returns a partial payload pre-spec** (`{sid, scenes: [], gates, autoRun}`) instead of 404 for gated sessions at the script/voice gates; full payload unchanged once spec.json exists. M6 gate pages can poll /state at ANY gate. (Holistic-review catch.)
6. **SSE single-flight registry lives in `preview/lib/sessionFlight.ts`** — ONE Map genuinely shared by start+approve routes (Next.js route modules can't export extra symbols; two per-file Maps would have broken ruling 4A silently).
7. **CLI details:** `--flag true|false` is a string per the plan contract (not store_true); failed-stage events are only emitted for a stage that was RUNNING (pre-stage validation errors like double-approve produce NO bogus failed card — design-ruling-5 scope); sid-first event prints before any ctx/engine work.
8. **Engine note for M5:** `rederive_stale()` relies on STAGE_ORDER being topological (commented in code); the §4.1 payment emits real per-stage events through it. M5's post-advance auto-fill hook and overrides-into-inputs seam land in `advance()`/engine context exactly as planned — nothing in M1 moved those seams.

**M1 STATUS: DONE — exit gate green (suite/tsc/E2E), per-task two-stage reviews + holistic cross-task review CLEARED.**

## M2 BUILD AMENDMENTS (2026-06-13)

M2 shipped (6 commits + band_miss surfacing): 432 backend green, preview typecheck clean, all four exit-gate test families green (per-preset bands · segment bytes · golden 60 · caps math). Ruled deviations M3–M7 must honor:

1. **No-bust hash (ruled):** `_input_hash` includes `target_length` ONLY when ≠60 — pre-M2 stage hashes stay valid at the default; preset flips still bust. Existing sessions pay nothing on resume.
2. **v2 CLIs thread the stored preset** (session_script/voice/timing/assemble/edit read `target_length` off the session row into build_ctx) — a 180 session edited via any v2 route re-derives at 180, not 60.
3. **Band retry is ALWAYS on for engine runs** (run_script passes target_length unconditionally; 60s band 5–8 = the frozen prompt's own instruction per OV-3). Direct legacy callers (main.py autopilot) keep parse-only retry.
4. **Honest degradation, richer than plan:** out-of-band→unparseable returns the parseable attempt-1 script WITH band_miss (never a dead stage); parse-fail×2 → clean ValueError. `bandMiss` (camelCase) rides the script payload (`session_script._serialize`) for the M6 warn pill — backend/session_script.py joined the M2 file map for this.
5. **Stub contract:** every fake of `generate_grounded_script` must accept `**kw` (target_length now always flows).
6. **CLI guard:** `--target-length` has `choices=[30,60,180,300]`; M6 topic chips must send exactly these (route forwards numbers verbatim; non-preset → generic CLI error, consider a friendly 400 in M6-T1 if desired).
7. Cosmetic debt (non-blocking): dead `_topic_for` in 5 CLIs; `verify_script`'s `max_targeted=3` literal vs MAX_TARGETED_BASE; no call-site pin test for the scaled cap.

**M2 STATUS: DONE — exit gate green.**

## M3 BUILD AMENDMENTS (2026-06-13)

M3 shipped (8d5e6a2 + stderr note): 440 backend green, typecheck clean, LIVE curl proof on :3100 — beat-1 preview synthesized once (24.6s cold, predicted hash 6d847a23c8bd in the filename), identical second call cache-hit (CLI 0.69s; route ~9s is pre-existing spawn+copy-assets overhead, not synth). Notes for M6:

1. Voice route now passes `--sid` on every preview; bogus sid degrades to the canned line (proven live, ok:true) — M6-T4 voice cards can post the sid unconditionally.
2. Cache filename: `voice_preview_{voice}_{sha1(text)[:12]}_{speed}.wav`; an edited beat 1 re-synthesizes on next preview automatically (new hash).
3. `_beat1_text` failures log to stderr and fall back canned — codec drift surfaces in route logs, never breaks the preview.
4. Route fixed overhead (~8s python spawn + copy-assets per POST) dominates cache hits — M6-T4 should show the spinner on FIRST play per voice and may reuse the returned path client-side for replays (the path is stable per (voice,text,speed)).

**M3 STATUS: DONE — exit gate green (cache-hit + threading tests, curl passthrough proven).**

## M4 BUILD AMENDMENTS (2026-06-13)

M4 shipped (d73b19d, e23232e, 26a861d, c07fa4d): 462 backend + 113 remotion green, tsc ×3, captions-suppress 7/7, contrast gate PASS on real pixels (min-tile Michelson 0.9355 with-clip vs 0.9809 baseline, threshold 0.8828) AND falsification-proven (SCRIM_ALPHA=0 → 0.2311 → exit 1). Gate stills in ~/Downloads/studio-v3-eyes-on/. Notes for M5/M6/M7:

1. HeroBackdrop: scrim SCRIM_ALPHA=0.55, gradient layer opacity 0.72 over a clip — heroBackground.ts untouched (delegation pinned by vitest; transitively byte-equal to pre-M4). No-clip mode is pixel-equivalent with one extra layer (gradient moved to a child AbsoluteFill), not byte-identical DOM.
2. `timing` is a required TemplateProps field and flows from renderScene (remotion/src/Video.tsx:85; dᵢ+Tᵢ on the transition path) — M5-T5's injected backgroundClip loop math aligns.
3. hero_bg_gate.py: TEXT_REGION pixel-derived for the gate's own title — re-derive if hero typography changes; it CLOBBERS root spec.json + remotion/public/spec.json (donor idiom) — never run mid-session with a staged spec; consider active-tiles hard floor + backup/restore wrapper if it joins CI. busy_test_pattern.mp4 (2.5MB) now lives in remotion/public/assets.
4. M5-T5: _scene_media emits kenBurns defaults + fit:cover; HeroBackdrop accepts null/absent too. The OffthreadVideo (loop:false) hero branch hasn't had its own still — M7 artifact (c) covers it.
5. test_spec_patch.py was NEW (plan said extend; none existed). backgroundClip patch-path + duration fences pinned there.

**M4 STATUS: DONE — exit gate green (lockstep schemas, suppression untouched, contrast gate falsification-proven).**
