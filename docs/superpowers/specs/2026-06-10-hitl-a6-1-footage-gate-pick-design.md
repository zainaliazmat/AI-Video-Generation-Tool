# HITL A.6.1 — Footage-gate Pick (preview API + UI foundation) — Design

**Date:** 2026-06-10
**Branch:** `hitl-a6-1-footage-gate-pick` (off `development`; PR → `development`, never master)
**Status:** Operator-approved (design sign-off; foundation + remaining decisions confirmed). Implementation plan follows.

First slice of **A.6** (the HITL gate UI / preview API surface), which lights up the
session edit ops that are built and persisted but **dark** in the browser. A.6.1 is the
thinnest *vertical* slice: surface the persisted session in the preview and let a user
**pick a different clip** from a footage scene's candidate pool, seeing the in-browser
Player update. It lays the session-backed foundation the other A.6 slices hang off.

## 0. Scope (ratified)

**In:**
- The preview drives a **live session**: `generate` surfaces its session id; new Next.js
  routes read session state and apply a footage `pick` edit; the Studio shows each
  footage scene's candidate pool and lets the user pick.
- Backend **spawn-per-request CLI entrypoints** (`session_state.py`, `session_edit.py`)
  that resume the already-persisted session by id and do one operation — matching the
  existing `/api/generate`→`main.py` and `/api/render`→remotion spawn pattern.
- `pick` updates **only the live in-browser Player** (reload the re-materialized
  `spec.json`); the exported MP4 re-render stays the existing explicit Render action.

**Deferred (later A.6 sub-projects):**
- **Re-query** UI (text → `re_query` op, hits Pexels) — **A.6.2**.
- **Upload** picker (file → A.2b `upload` op) — **A.6.3**.
- **Provenance badges** (A.2a `media_provenance` per scene) — **A.6.4**. (The `/state`
  route already returns provenance; only the badge *UI* defers.)
- Multi-session management / session list. One active session at a time, matching the
  existing single-flight shared-`spec.json` model.
- A long-lived Python session server (rejected: an edit gate is human-paced; per-call
  interpreter startup is invisible and a supervised second process is YAGNI).
- Re-architecting `/api/generate` onto the Session API `run_all` (rejected: destabilizes
  a working generate path to lay a foundation; a legitimate later isolated refactor).

## 1. Non-negotiable invariants

1. **The backend session machinery is reused as-is, not rebuilt.** `main.run` already
   mints `auto-<uuid>`, persists every stage output (incl. the footage candidate pool +
   provenance) to `backend/.sessions/sessions.db`, and the run is **resumable by id**
   (`api.resume`). A.6.1 adds only thin CLI wrappers + Next routes + UI over it.
2. **Autopilot path unchanged.** Generate still spawns `main.py --topic`; the only
   backend change to that path is **emitting the existing `sid`** on the terminal
   progress event. No spec.json content change; the autopilot golden + A.1/A.2a tests
   stay green.
3. **`pick` is offline + deterministic** (it reads the stored pool the user was shown —
   the A.1 guarantee), so the edit route makes **no** network call and binds exactly the
   chosen clip.
4. **Single-flight.** Edits mutate the shared `spec.json`/assets; one edit (and one
   generate) at a time, mirroring the existing generate single-flight. A concurrent edit
   returns busy (409), never a torn write.
5. **Fail-loud.** A bad `sid`, an edit targeting a non-footage scene, or an unknown rank
   surfaces an error to the UI — never a silent no-op or a broken spec.

## 2. Backend — CLI entrypoints (new, thin)

Two small entrypoints under `backend/`, each: build the **same** `EngineContext`
`main.py` builds (catalog, `assets_dir`, `spec_out` = repo-root `spec.json`, etc.),
`api.resume` the session, do one thing, print one JSON line to stdout, exit. Human logs
to stderr (keeps stdout parseable, per the `--progress-json` precedent).

### 2.1 `session_state.py --sid <id>` (read-only)

```json
{
  "sid": "auto-…",
  "scenes": [
    {
      "index": 1,
      "template": "scene",
      "needsFootage": true,
      "candidates": [
        {"rank": 1, "thumbUrl": "https://…", "durationFrames": 630, "selected": true},
        {"rank": 2, "thumbUrl": "https://…", "durationFrames": 450, "selected": false}
      ],
      "provenance": {"source": "auto", "query": "coral reef", "rank": 1, "pexelsId": …, "pexelsUrl": "…"}
    }
  ]
}
```

- `candidates` per footage scene from `store.get_footage_candidates` (rank, thumb_url,
  duration_frames, selected); non-footage scenes carry `needsFootage:false` + empty
  candidates. `provenance` from `api.media_provenance` (present per scene, `null` if
  unrecorded). Read-only — never mutates.

### 2.2 `session_edit.py --sid <id> --op pick --scene <n> --rank <r>`

- `api.resume` → `api.edit("footage", {"op":"pick","scene_index":n,"rank":r})`. The
  `edit()` wrapper invalidates downstream, re-derives assemble, and **re-materializes
  `spec.json`** at `spec_out`. Prints `{"ok": true, "sid": "…"}`. A non-footage scene /
  unknown rank raises (caught → `{"ok": false, "error": "…"}`, non-zero exit).
- Only `op="pick"` is accepted in A.6.1; any other `op` → error (re-query/upload arrive
  in A.6.2/A.6.3).

## 3. Backend — generate surfaces the sid

`main.py`'s `--progress-json` terminal event currently signals completion; add the
minted `sid` to it (e.g. `PROGRESS {"stage":"done","sid":"auto-…"}` or the existing
done line + `sid`). `run()` already has `sid` in scope ([main.py:91-93]). No other
autopilot change.

## 4. Preview — Next.js API routes (spawn pattern)

- `GET /api/session/[id]/state` → spawn `python backend/session_state.py --sid <id>`,
  parse stdout JSON, return it. 404/error on bad id.
- `POST /api/session/[id]/edit` (body `{op:"pick", scene:number, rank:number}`) →
  **single-flight guard** (reject 409 if a generate/edit is in flight) → spawn
  `python backend/session_edit.py --sid <id> --op pick --scene <scene> --rank <rank>` →
  on `{ok:true}`, run the existing `copy-assets` (mirror any newly-referenced asset into
  `preview/public`) → return `{ok:true}`. On `{ok:false}` → 4xx with the error.
- Reuse the generate route's PYTHON/REPO_ROOT/spawn helpers (factor a tiny shared
  `spawnJson` helper if it reduces duplication; don't over-abstract).

## 5. Preview — frontend (`Studio.tsx` + a gate panel)

- On the generate `done` SSE, capture `sid`; `GET /api/session/<sid>/state`.
- **Footage-gate panel** (new component, e.g. `FootageGate.tsx`): for each scene with
  `needsFootage`, render the candidate pool as a **thumbnail grid** (`thumbUrl`), the
  `selected` clip highlighted. Clicking a thumbnail → `POST /api/session/<sid>/edit
  {op:"pick", scene, rank}`.
- On `{ok:true}`: **reload `/spec.json` into the in-browser Player** (the Player already
  takes the spec as a prop — re-fetch + re-key it) so the new clip shows instantly; mark
  the exported MP4 **stale** with a small "preview changed — re-render to export" hint.
  **No auto MP4 re-render** — the live Player is the gate's feedback loop; the Render
  button stays the explicit export.
- Pick is disabled while an edit is in flight (mirrors the single-flight backend).

## 6. Data flow

1. **Generate:** UI → `/api/generate` → `main.py` (autopilot, persists session) emits
   `sid` → UI stores `sid`, fetches `/state` → renders the gate panel.
2. **Pick:** UI click → `/api/session/<sid>/edit {pick}` → `session_edit.py` resumes +
   edits + re-materializes `spec.json` → route runs `copy-assets` → UI reloads
   `/spec.json` into the Player (instant) + flags the MP4 stale.
3. **Re-state (optional):** UI → `/api/session/<sid>/state` to refresh the pool's
   `selected` after a pick (the edit re-marks selection in the pool).
4. **Export:** unchanged — explicit Render button → `/api/render` → MP4.

## 7. Error handling

- Bad `sid` (no such session) → `session_state`/`session_edit` exit non-zero → route
  4xx → UI shows "session not found (re-generate)".
- Edit on a non-footage scene / unknown rank → `edit()` raises → `{ok:false,error}` →
  route 4xx → UI surfaces the message; pool unchanged.
- Concurrent edit/generate → route 409 → UI keeps the pick disabled / shows "busy".
- A stale Player (spec reload failed) → the existing Player error surface; the session
  state is intact (re-fetch `/state`).

## 8. Testing

- **Backend entrypoints:** `session_state` returns the documented shape for a seeded
  session (footage scene has candidates + provenance; non-footage `needsFootage:false`);
  `session_edit pick` applies the edit, re-materializes `spec.json` with the new clip,
  and re-marks `selected`; bad sid / non-footage scene / unknown rank fail loud
  (non-zero exit + `{ok:false}`). Reuse the A.1/A.2a seed (faked script/tts/timing/pexels)
  — offline.
- **Routes:** `GET state` returns the JSON; `POST edit` applies + triggers copy-assets;
  single-flight returns 409 under a simulated in-flight edit; bad id → 4xx.
- **Frontend:** the gate panel renders a pool from `/state`; clicking a non-selected
  thumbnail POSTs the right `{scene,rank}` and, on ok, re-fetches the spec into the
  Player; the Render button still exports; pick disabled while in flight.
- **Autopilot regression:** the spec.json byte-identity golden + A.1/A.2a suites stay
  green (the only backend change is emitting `sid`).
- **E2E eyes-on (visual gate, per project rhythm):** generate → the gate panel shows the
  footage scene's pool with the auto pick highlighted → click a different clip → the
  in-browser Player updates to the new clip (timing unchanged) → Render still exports the
  chosen clip. (Eyes-on the gate working in-browser before merge.)

## 9. Out of scope (explicit)

Re-query (A.6.2), upload (A.6.3), provenance badge UI (A.6.4), multi-session management,
a long-lived Python server, and re-architecting generate onto the Session API. A.6.1 is
the session-backed **pick** vertical slice + the routes/entrypoints it needs.
