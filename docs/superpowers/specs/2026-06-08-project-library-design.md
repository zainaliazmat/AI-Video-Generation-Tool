# Project Library — Persistence Across Sessions & Routes

**Date:** 2026-06-08
**Branch:** phase-4-query-specificity (or a dedicated `phase-5-project-library`)
**Status:** Design — pending implementation plan

## Problem

Generated videos and render history do not survive a page refresh or route change.
Two distinct causes:

1. **Render history is in-memory only.** `Studio.tsx` holds it in
   `useState<RenderRecord[]>([])`. A refresh or navigation drops it entirely.
2. **There is only ever one of everything.** The pipeline writes a single
   `spec.json` (overwritten each generate), a single `voiceover.wav` (overwritten),
   and the renderer writes a single `remotion/out/video.mp4` (overwritten). There is
   no concept of more than one saved video.

### What is already (accidentally) persistent

- **Footage clips** are content-addressed (`footage_<hash>.mp4`). A new run writes a
  new file and never overwrites an old one, so they already survive — at the cost of
  unbounded disk growth (~759 MB today, no cleanup).
- The **single `voiceover.wav`** and **`out/video.mp4`** are overwritten every run.
  These two clobbered files are the real reason an old video can't be re-opened
  pixel-perfect.

### Two single-slot `spec.json` dependencies (both must be addressed)

- The **in-app Player** takes `spec` as a prop (`Studio` → `PlayerClient`), so
  re-preview just needs the spec handed to it — no file involved.
- The **CLI renderer** reads `remotion/public/spec.json` via
  `fetch(staticFile('spec.json'))` (`remotion/src/Root.tsx`), staged today by a
  `copy-spec` step from the repo-root `spec.json`. To render a chosen project, we stage
  *that project's* spec into this slot right before rendering — turning it from a
  source of truth into a transient render input.

## Goal

A **Project Library**: every generation becomes a saved project the user can re-open,
re-preview pixel-perfect in the Player, **render / re-render**, download the MP4 of, and
delete. Persists across refresh, route change, and server restart.

### Non-goals (YAGNI)

- No auth, no multi-user, no cloud sync.
- No rename / tags / search.
- No automatic retention — cleanup is manual delete only.
- No automatic footage garbage collection (the shared pool) — see Deferred.

## Decisions (locked)

1. **Backend mints the project ID.** Format `YYYYMMDD-HHMM-<topic-slug>`
   (slug = lowercased, hyphenated, truncated topic); short suffix on collision.
2. **Re-preview is pixel-perfect**, which requires namespacing the voiceover
   (`voiceover_<id>.wav`) so it is never overwritten. Footage is already
   content-addressed.
3. **Re-render is in scope.** Re-opening a project can render or re-render it, enabled
   by staging the project's spec into the renderer's slot.
4. **Directory scan is the source of truth — no global `index.json`.** Listing reads
   `projects/*/` directly. A per-project `meta.json` sidecar makes listing cheap; it is
   *not* a global index (one writer, lives in the folder, cannot drift or race).
5. **Projects are served via API routes, not mirrored into `preview/public`** — avoids
   doubling large MP4s into the already-heavy `copy-assets` step.
6. **No root/default `spec.json` as a source of truth (Option 2).** The Player loads
   the latest (or selected) project via the API; an explicit empty state shows when
   there are no projects.
7. **Cleanup is manual delete** via a `DELETE` endpoint + a UI control.

## Approach (storage mechanism)

| Option | Summary | Verdict |
|---|---|---|
| **A — Filesystem per-project, directory-scanned** | Each run gets an `id`; `spec.json` + `sources.json` + `meta.json` (+ `video.mp4` after render) live in `projects/<id>/`; media stays in the shared content-addressed pool; the list is a directory scan. | **Chosen** — fits the existing "Python writes files, Next serves files" architecture, survives restarts, zero new dependencies, single source of truth. |
| B — SQLite metadata + files for blobs | Cleaner queries, atomic writes. | Rejected — adds a dependency + migrations; overkill for a single-user local tool. |
| C — localStorage / IndexedDB only | Frontend cache of specs + records. | Rejected — does not preserve assets; old previews break when a shared slot is overwritten. |

## Architecture

### Directory layout

```
projects/
  20260608-1430-deep-sea-facts/
    spec.json          # snapshot of the render contract for this run
    sources.json       # grounding citation sidecar for this run
    meta.json          # list sidecar: {id, topic, title, createdAt, durationInFrames, fps}
    video.mp4          # render snapshot — present only after a render
remotion/public/assets/
  footage_<hash>.mp4   # shared, content-addressed (unchanged)
  voiceover_<id>.wav   # NEW: namespaced per project, never overwritten
  music/...            # unchanged
remotion/public/spec.json   # transient render input only (staged per render; not a source of truth)
remotion/out/video.mp4      # transient render output slot (copied into projects/<id>/ on success)
```

Media (footage + voiceover) stays in the shared `assets/` pool so the existing
`copy-assets` mirror and `staticFile("assets/...")` resolution keep working unchanged.
A "project" is the snapshot of its `spec.json` (pointing at id-namespaced,
never-overwritten media) plus its render and `meta.json`.

### `meta.json` (per-project sidecar) shape

```json
{
  "id": "20260608-1430-deep-sea-facts",
  "topic": "3 facts about deep sea creatures",
  "title": "3 Facts About Deep Sea Creatures",
  "createdAt": 1749393000000,
  "durationInFrames": 1234,
  "fps": 30
}
```

`hasRender` is **not** stored — it is derived per request from whether
`projects/<id>/video.mp4` exists, so it can never go stale.

## Changes by layer

### 1. Backend — `backend/main.py` + tts stage

- Mint `project_id` at the start of `run()`.
- Write the voiceover as `assets/voiceover_<id>.wav` (namespaced); the spec/sources
  builders reference the namespaced path. Footage unchanged.
- After assembling: create `projects/<id>/` and write `spec.json`, `sources.json`, and
  `meta.json` into it. **Stop writing the repo-root `spec.json`.**
- Emit `project_id` on the progress stream's terminal event.

### 2. Generate route — `preview/app/api/generate/route.ts`

- Forward the backend-emitted `project_id` to the client in the `done` SSE event
  (`{type:'done'}` → add `id`).
- `copy-assets` continues to mirror the shared `assets/` pool into
  `preview/public/assets/` (so the Player resolves the namespaced voiceover + footage).
  The `projects/` tree is **not** mirrored — it is served via API routes.
- Drop the repo-root-`spec.json` copy from `copy-assets` (Player no longer loads it).

### 3. Render route — `preview/app/api/render/route.ts`

- Accept the active `project_id` in the POST body (enables render + re-render).
- Before rendering, stage `projects/<id>/spec.json` → `remotion/public/spec.json`
  (replacing the old `copy-spec`-from-root behavior).
- On success, copy `remotion/out/video.mp4` → `projects/<id>/video.mp4`.

### 4. New API routes

- `GET  /api/projects` → directory-scan `projects/*/`, return each `meta.json` plus a
  derived `hasRender` (newest first by `createdAt`).
- `GET  /api/projects/:id` → that project's `spec.json` (+ `sources.json`) for
  re-preview.
- `GET  /api/projects/:id/video` → stream `projects/<id>/video.mp4` with range support
  (mirror the existing `render/output` route).
- `DELETE /api/projects/:id` → remove `projects/<id>/` and its namespaced
  `assets/voiceover_<id>.wav` (+ the `preview/public/assets` mirror copy). Footage is
  shared/content-addressed and left in place. Idempotent.

### 5. Frontend — `Studio.tsx` + `HistoryList.tsx`

- On mount, load the project list from `/api/projects`; select the newest and load its
  spec via `/api/projects/:id` into the Player → **survives refresh + route change.**
- **Empty-library state:** when the list is empty, the Player area shows an explicit
  "No videos yet — generate one to get started" placeholder (replaces the old default
  spec load).
- After a successful generate/render, refresh the list and select the affected project.
- Replace the in-memory `history` list with the server list: each row re-opens the
  project (loads its spec into the Player), exposes its MP4 (`hasRender`) via
  `/api/projects/:id/video`, a **Render / Re-render** action, and a **Delete** action
  (`DELETE /api/projects/:id`).

## Data flow

1. **Generate:** UI → `/api/generate` → backend mints `id`, writes namespaced voiceover
   + `projects/<id>/{spec,sources,meta}.json`, emits `id` → route mirrors assets into
   `preview/public` → UI loads `/api/projects/:id`, refreshes list, selects it.
2. **Render / re-render:** UI → `/api/render` with `id` → route stages
   `projects/<id>/spec.json` into `remotion/public/spec.json` → renders → copies
   `out/video.mp4` → `projects/<id>/video.mp4` → UI refreshes list.
3. **Re-open:** UI → `/api/projects/:id` → spec into Player (media resolves from the
   id-namespaced, never-overwritten shared pool) → pixel-perfect.
4. **Delete:** UI → `DELETE /api/projects/:id` → folder + namespaced voiceover removed
   → UI refreshes list.

## Error handling

- `projects/` missing/empty → empty list → Player empty state.
- A project folder missing `meta.json` or `spec.json` → skipped from the listing (and
  removable via delete); the directory scan never throws on one bad folder.
- Re-render where footage/voiceover was manually deleted → render fails with the
  existing render-error surface; the project row stays (no MP4 produced).
- Delete of a missing id → idempotent no-op.
- Render single-flight (`rendering` flag) already serializes renders; generate
  single-flight serializes generations. Because the list is derived (no shared index
  file is written), there is no cross-process write race to guard.

## Testing

- **Backend:** id minting (format, slug, collision suffix); namespaced voiceover path
  in spec; `projects/<id>/{spec,sources,meta}.json` written; root `spec.json` no longer
  written.
- **API routes:** list (newest-first, derived `hasRender`, skips malformed folders);
  get spec; video stream (range); delete (removes folder + voiceover, idempotent,
  leaves footage).
- **Frontend:** list loads on mount; survives a simulated remount; empty state when no
  projects; re-open loads the correct spec; render/re-render updates `hasRender`; delete
  removes the row.
- **E2E (visual gate, per project rhythm):** generate → render → refresh → project still
  listed with MP4 → re-open → Player shows the same hero frame; generate a second →
  both listed; delete one → only the other remains (eyes-on before merge).

## Deferred

- Automatic retention ("keep last N") — manual delete only for now.
- Footage garbage collection (the ~759 MB shared pool) — deleting a project does not GC
  shared footage; a separate "prune unreferenced footage" pass could be added later.
- `copy-assets` copies the whole `assets/` dir on every predev/prebuild/prestart and
  will grow as `voiceover_<id>.wav` files accumulate; an incremental/symlink mirror is a
  possible later optimization, out of scope here.
