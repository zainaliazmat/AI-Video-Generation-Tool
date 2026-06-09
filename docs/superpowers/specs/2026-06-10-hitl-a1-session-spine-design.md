# HITL A.1 — Session Spine + Footage Gate — Design

**Date:** 2026-06-10
**Branch:** `hitl-a1-session-spine` (off `development`; PR → `development`, never master)
**Status:** Approved (reviewer). Implementation plan follows.

The second slice of the Human-in-the-Loop pipeline (`faceless-video-HITL-spec`, §3/§5),
after Plan #1 (Phase-4 Quality Core) merged to `development` via PR #9. A.1 builds the
**session spine** — the resumable, gated state machine + persistence + invalidation engine
that "everything else hangs off" — and proves it end-to-end with **one real gate (footage)**
rather than a generic stub.

## 0. Scope (ratified)

**In:**
- The session document + SQLite persistence (resumable).
- A state-machine **orchestrator** (rewrite of `main.run()`'s linear flow) that owns stage
  order, status, and invalidation — **calling the existing, proven stage executors**, not
  reimplementing them.
- The invalidation / re-derive matrix (§3.3 of the HITL spec), idempotent, input-hash cached.
- A programmatic Session API: `create / get / advance / run_all / edit / regenerate / resume`.
- The **footage gate** as the one real vertical slice: `re-query` and `pick-from-pool` edit
  ops → invalidate assemble only → idempotent re-derive → new `spec.json`.

**Deferred (own later cycles):**
- The other gates' review surfaces + edit ops (script chat, voice picker, assemble edit-chat) —
  A.3/A.4/A.5.
- DeepSeek chat / tool-use; the footage DeepSeek re-query — A.2/A.3/A.5.
- User uploads; the per-scene **media-override + provenance contract change** (a `spec.json`
  change, its own decision §10.2) — A.2. A swap/re-query in A.1 records the choice in the
  **session**, so `spec.json` stays render-only.
- All preview API / frontend wiring + the functional harness — A.6.

## 1. Non-negotiable invariants (carried from the HITL spec)

1. **`spec.json` is render-only.** The renderer reads only `spec.json` on disk — never the
   session DB. The session *wraps* `spec.json`; it does not replace it.
2. **1 beat = 1 narration span = 1 scene; footage never feeds span/timing.** The matrix
   enforces this: a footage edit invalidates **assemble only**, never script/voice/timing.
3. **Autopilot unchanged (invariant #7).** With zero interaction the engine runs end-to-end
   on defaults and produces the **byte-identical** `spec.json` the old `run(topic)` produced.
   Proven by a golden-output regression test, not assumed.
4. **Idempotent re-derive.** Re-running a stage with identical inputs is a no-op (input-hash
   cache hit). The single most important correctness property: never silently serve stale
   downstream after an upstream edit.
5. **Local-first, near-$0, fails closed.** SQLite via stdlib `sqlite3` (no new dependency).

## 2. Components (focused modules, one responsibility each)

- `backend/session/store.py` — SQLite persistence. Opens/migrates the DB, loads/saves the
  session document and stage rows, the footage candidate pool. Pure storage; no orchestration.
- `backend/session/stages.py` — the **declarative stage table**: for each stage, its executor
  callable, its upstream input dependencies, and its downstream invalidation set (the matrix
  in ONE place so the routing signal can't drift).
- `backend/session/engine.py` — the orchestrator: `advance`, `run_all`, `edit`, `regenerate`,
  `invalidate`; input-hash computation; idempotent cache logic. Depends on `store` + `stages`.
- `backend/session/api.py` — the programmatic Session API surface
  (`create/get/advance/run_all/edit/regenerate/resume`). Thin; delegates to `engine`.
- `backend/main.py` `run(topic)` → thin wrapper: `api.create(topic)` → `engine.run_all` →
  the resolved `spec.json` is written to its existing on-disk location for the renderer.

The existing stage modules (`script.py`, `tts.py`, `timing.py`, `footage.py`, `assemble.py`,
`recipe.py`, `validate.py`) are **unchanged except**: `footage.py` gains a candidate-pool
exposure (reusing `footage_diagnostic`'s ranking) so `pick-from-pool` has data to pick from.

## 3. SQLite schema

DB at `backend/.sessions/sessions.db` (gitignored). stdlib `sqlite3`. Schema created on first
open (a small idempotent `CREATE TABLE IF NOT EXISTS` migration).

```sql
sessions(
  id            TEXT PRIMARY KEY,   -- generated session id
  topic         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  current_stage TEXT,               -- furthest stage reached
  spec_path     TEXT                -- on-disk spec.json this session renders
);

stages(
  session_id    TEXT NOT NULL,
  stage         TEXT NOT NULL,      -- script|voice|timing|footage|assemble|render
  status        TEXT NOT NULL,      -- pending|done|stale|approved|error
  input_hash    TEXT,               -- hash of upstream outputs + params at last run
  output_json   TEXT,              -- serialized stage artifact (binaries referenced by path)
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, stage)
);

footage_candidates(
  session_id      TEXT NOT NULL,
  scene_index     INTEGER NOT NULL, -- which footage scene
  rank            INTEGER NOT NULL, -- Pexels relevance rank
  query           TEXT NOT NULL,    -- the (hardened) query that produced this pool
  clip_path       TEXT,             -- cached clip path once downloaded
  duration_frames INTEGER,
  thumb_url       TEXT,
  selected        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, scene_index, rank)
);
```

Binaries (`voiceover.wav`, `footage_*.mp4`) stay in `remotion/public/assets`, referenced by
path in `output_json`/`clip_path`. `spec.json` stays on disk for the renderer; `spec_path`
records where.

## 4. The state machine + invalidation engine

**Stage order:** `script → voice → timing → footage → assemble → render`.

**`advance(session, stage)`** (idempotent):
1. Compute `input_hash = hash(serialized upstream outputs this stage depends on + params)`.
2. If the stored `stages.input_hash == input_hash` and `status == done` → **no-op** (cache hit).
3. Else run the stage's executor (the existing stage fn), persist `output_json`, set `done`,
   store the new `input_hash`.

**`run_all(session)`** — advance each stage in order → autopilot → write `spec.json`. Replaces
the old linear `run()` body.

**`edit(session, stage, op)`** — apply a stage-specific edit op (A.1 implements the footage
ops); update that stage's `output_json`; call `invalidate(session, stage)`; re-derive the
stale stages on demand (advance them).

**`invalidate(session, from_stage)`** — set `status = stale` for every stage in the matrix's
downstream set of `from_stage`.

**The matrix (declared once in `stages.py`):**

| Edited stage | Marks stale (downstream) |
|---|---|
| script | voice, timing, footage, assemble, render |
| voice | timing, footage, assemble, render |
| timing | assemble, render |
| **footage** | **assemble, render** |
| assemble | render |

## 5. The footage gate (the one real vertical slice)

**Executor enhancement.** When the footage stage runs, it records the **candidate pool** per
footage scene into `footage_candidates` (rank, query, thumb_url, duration; `clip_path` filled
once a candidate is downloaded), plus marks the selected clip. Reuses
`footage_diagnostic.summarize_candidates` for the ranking so there's one ranking path.

**Review surface (data, not UI).** Per footage scene, the Session API exposes: the chosen clip,
its query, and the ranked candidate pool. (A relevance flag + thumbnails-in-UI are A.6.)

**Edit ops (A.1):**
- `re_query(scene_index, new_query)` — re-run the Pexels search for that scene with the new
  query (passed through Plan #1's `harden()`), refresh that scene's candidate pool + selected
  clip, update the footage output, invalidate `{assemble, render}`, re-derive assemble → new
  `spec.json`.
- `pick(scene_index, rank)` — select a different candidate from the persisted pool (download it
  if not cached; no re-search), update the footage output, invalidate `{assemble, render}`,
  re-derive assemble.

Both prove the spine end-to-end: edit → correct downstream invalidation (assemble only —
timing untouched) → idempotent re-derive → `spec.json` reflects the new clip.

## 6. Testing

- **Engine units:** identical-input `advance` is a no-op (hash cache hit); `edit` marks exactly
  the matrix's downstream set stale (one test per edited stage); re-derive is idempotent.
- **Golden autopilot regression:** the new engine `run(topic)` produces a `spec.json`
  byte-identical to the pre-A.1 path, with providers mocked/faked (the load-bearing
  invariant-#7 proof). Reuse the existing E2E fakes.
- **Footage gate:** `re_query` and `pick` → assemble re-derives, **timing/spans unchanged**
  (regression guard mirroring `test_clip_duration_only_toggles_loop_never_timing`), `spec.json`
  reflects the new clip; the candidate pool persists and `pick` does not re-search.
- **Store:** round-trip persistence; resume a session mid-flow (load → advance the remaining
  stages); schema migration is idempotent (open an existing DB twice).

## 7. Out of scope (explicit)

The other gates (script/voice/assemble), DeepSeek chat/tool-use, user uploads, the
media-override/provenance contract change, preview API + frontend harness, multi-aspect /
cloud render. A.1 is the spine + the footage gate only.
