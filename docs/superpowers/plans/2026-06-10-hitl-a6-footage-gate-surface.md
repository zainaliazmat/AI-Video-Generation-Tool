# HITL A.6 — Footage-gate surface cycle (6.2 re-query · 6.3 upload · 6.4 badges)

Continues A.6.1 (pick). One coherent branch finishes the per-scene footage-gate UI:
re-query, user upload, and provenance badges. All three extend the SAME four files
(FootageGate.tsx, Studio.tsx, session_edit.py, edit/route.ts) — built sequentially
with TDD, not parallel subagents (they would collide on shared files).

## Ground truth (verified on disk, not assumed)

- `development` tip = `b5cc991` (A.2a merge). A.6.1 branch forked there; nothing past it in development.
- **re_query engine op is LIVE on this branch** (engine.py:142-148, arrived via A.2a). Hardens
  query → Pexels search → auto-binds **rank 1** of the new pool → stamps `re_query`. Blocked only
  by `session_edit.py` `choices=["pick"]` and `route.ts` `op==='pick'`.
- **A.2b upload backend is on `hitl-a2b-user-uploads`, NOT in development, NOT on this branch.**
  Op: `edit("footage", {"op":"upload","scene_index":int,"file":str})`. Extension-classified
  (video: mp4/mov/webm/m4v, image: jpg/jpeg/png/webp), content-hashed staging, `source="uploaded"`,
  query=filename, rank/pexels=None. Fail-loud: missing file / bad ext / unprobeable video / no clip
  at scene. Touches backend only (engine, media_probe, contracts.kind, assemble, store) — clean
  merge with A.6.1 (zero file overlap, verified).
- **`/state` already returns full provenance** per scene (`source, query, rank, pexelsId, pexelsUrl`,
  session_state.py:41-43). A.6.4 badges need NO backend — only widen the TS type + render.
- `PEXELS_API_KEY` present in `.env` → re-query is eyes-on testable.

## Decisions

1. **Branch `hitl-a6-footage-gate-surface`** off A.6.1 tip (a7eb211); **merge `hitl-a2b-user-uploads`**
   (real merge, SHAs preserved → shared history when it lands in development). Bundles the complete
   footage-gate surface + its A.2b dependency into one operator PR.
2. **Skip brainstorming** — requirements crisp, backends exist with known contracts, design
   constrained by the A.6.1 pattern; user forbade questions.
3. **Direct sequential TDD**, not parallel subagents — shared files. Independent code-review at the end.
4. **re-query UX** = type a new query → backend rebinds to the new top hit → re-fetch `/state` to show
   the new pool with rank 1 selected. (No rank choice; that is what `pick` is for.)
5. **upload UX** = pick a file from the scene row → multipart POST → engine binds it → re-fetch state.

## Tasks

- **T0** Branch + merge a2b; backend pytest green.
- **T1** `session_edit.py`: dispatch `pick|re_query|upload` (add `--query`, `--file`); fail-loud preserved. TDD: test_session_cli.py.
- **T2** `edit/route.ts`: accept `re_query` (json `{op,scene,query}`) + `upload` (multipart file → temp → `--file` → cleanup). Keep single-flight + copy-assets.
- **T3** A.6.2: FootageGate per-scene re-query input+button; Studio `reQuery()` + state refetch.
- **T4** A.6.3: FootageGate per-scene upload control; Studio `upload()` (multipart).
- **T5** A.6.4: widen `GateScene.provenance`; render badges (source, rank, Pexels link, uploaded filename).
- **T6** backend pytest + preview `tsc` green.
- **T7** Eyes-on: generate → re-query → upload → badges; screenshots.
- **T8** Commit per slice; update memory; report.

## Out of scope (recorded residuals)

- Multi-tab stale-sid, cross-route single-flight (single-user local-first — same as A.6.1).
- A.2c DeepSeek re-query stays PARKED; this is the plain Pexels re-query only.
