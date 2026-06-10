# HITL A.2a — Per-Scene Media Provenance — Design

**Date:** 2026-06-10
**Branch:** `hitl-a2a-media-provenance` (off `development` @ `5ba1e92`; PR → `development`, never master)
**Status:** Operator-approved (4-section design + the two ground-truth refinements below). Implementation plan follows.

The first cycle of **A.2** (media-override + provenance), which was decomposed into three
ordered, independently-shippable slices: **A.2a provenance (this doc)** → A.2b user uploads →
A.2c DeepSeek re-query. A.2a builds the **per-scene media provenance record** — *where each
footage scene's clip came from* (auto pick / you-picked / re-queried) — captured **session-only**
so the future A.6 gate UI can render source badges ("auto" / "you picked #N" / "re-queried: X",
and later "uploaded"). Built directly on the A.1 session spine (PR #10, merged).

## 0. Scope (ratified)

**In:**
- A per-footage-scene **provenance record** in the session DB: `source` (`auto` | `pick` |
  `re_query`) + the resolved `query` + the selected clip's actual `rank` + Pexels `{id, url}`.
- **Surfacing** `fetch_footage`'s real choice: extend `select_clip` to return the chosen clip's
  rank + Pexels id/url, carry them on the `Clip`, and stamp the record when footage advances.
- A read accessor on the Session API: `api.media_provenance(sess)`.
- Tests only (engine/store/stage units + the full A.1 regression).

**Deferred (own later cycles):**
- User uploads + the `uploaded` source value — **A.2b**.
- DeepSeek-driven re-query (the natural-language → query path) — **A.2c** (the `re_query` *record
  shape* is built now; only the DeepSeek *driver* is deferred).
- The A.6 badge UI itself, the preview API, and the frontend harness — **A.6**. This includes the
  **broaden-after-whiff pool-display residual** (§5.1): A.2a records the provenance value correctly,
  but reconciling the *displayed* candidate pool with a clip sourced from the broadened title search
  is an A.6 concern (tolerate "selected not in pool", or persist the resolved pool there).
- A credits/attribution feature. `pexels_id`/`pexels_url` are captured as **origin-completeness**
  (so a later credits feature *can* be built), not as a credits feature now.
- An edit-history log + timestamps. The record is **current-state, one row per scene**
  (overwritten on edit); there is nothing to order, so no timestamp (YAGNI).

## 1. Non-negotiable invariants

1. **`spec.json` is render-only and byte-unchanged by A.2a.** Provenance lives in the session DB
   only. `assemble.build_spec` reads only the `Clip`'s `index`/`query`/`path`/`duration_frames`;
   the new provenance fields are ignored, so the rendered `spec.json` is **byte-identical** to the
   A.1 output. The A.1 content-identity / golden-autopilot regression stays green — this is the
   one load-bearing invariant and is proven, not assumed.
2. **Current-state, one row per scene.** `media_provenance` has `PK(session_id, scene_index)`; an
   edit overwrites that scene's row. No history, no timestamp.
3. **`rank` is the *actual* pool position.** Surfaced from `select_clip`'s real choice — not
   assumed to be rank 1. The K-floor can push the auto pick past rank 1, and a whiffing specific
   query can broaden to the title; both are recorded faithfully (see §2, §5).
4. **Provenance is a session artifact, never a render input.** Capturing it must not change the
   rendered output. (It rides on the `Clip` and therefore lands in the footage `output_json`,
   which perturbs assemble's *internal* `input_hash` value only — harmless; see §4.1.)
5. **Local-first, near-$0, additive.** No new dependency; SQLite via the A.1 store; the A.1 suite
   stays green (218 tests) — A.2a is purely additive.

## 2. Footage-stage extension (surface the real choice)

The auto-selection is **approximate today**: `session/executors.run_footage` marks `selected` by
guessing rank-1 of the matching query and concedes (lines 118–127) that *"The Clip doesn't expose
which candidate it chose. Exact tracking is deferred to A.6."* A.2a is the slice that makes it
**exact**, by surfacing `select_clip`'s decision instead of guessing.

**`pipeline/contracts.Clip`** — gains three **optional** provenance fields (default `None`):

```python
@dataclass
class Clip:
    index: int
    query: str
    path: str
    duration_frames: int | None = None
    rank: int | None = None          # NEW: 1-based position among usable clips in the chosen search
    pexels_id: int | None = None     # NEW: Pexels video object id of the chosen clip
    pexels_url: str | None = None    # NEW: Pexels page url of the chosen clip
```

Defaults keep every existing `Clip(index=…, query=…, path=…, duration_frames=…)` construction and
all A.1 fixtures working. `codecs.clips_to_json` (`asdict`) and `clips_from_json` (`Clip(**c)`)
round-trip the new fields automatically; **old A.1 footage JSON lacking the keys still loads**
(missing keys → defaults).

**`pipeline/footage.select_clip`** — currently returns `(link, duration_frames)`. It already walks
Pexels relevance order applying the soft loop floor; A.2a extends it to also report **which** clip
it chose. Return a small `Selection` namedtuple to keep one ranking path and avoid a wide tuple:

```python
Selection = namedtuple("Selection", "link duration_frames rank pexels_id pexels_url")
```

`rank` mirrors `candidate_rows`' semantics exactly — **1-based among *usable* portrait clips**
(`len(usable_so_far) + 1`), so the provenance rank equals the displayed-pool rank and the `pick`-by-
rank op and the A.6 "#N" badge stay consistent. The `first_usable` fallback (floor cleared by
nothing) carries the fallback clip's own rank/id/url. Two call sites unpack `select_clip`'s tuple
today and must adapt to the namedtuple:
- `_fetch_one` (§2 below) — reads `.link`/`.duration_frames` plus the new `.rank`/`.pexels_id`/
  `.pexels_url`.
- `footage_diagnostic.kfloor_pick` — reads `.link`/`.duration_frames` only and **keeps its own
  link-locate loop**: it deliberately reports an *all-videos* rank (1-based over every video,
  including non-usable, to line up with `summarize_candidates`), which is a different metric from
  `select_clip`'s usable-only rank. It must **not** substitute `.rank`. Its `(rank, frames)`
  contract is unchanged, so its tests stay green.

The 5 `link, dur_f = select_clip(...)` unpackings in `tests/test_footage.py` update to the
namedtuple in the same step as the signature change (collateral of the arity change, not the
behavior under test).

**`pipeline/footage.candidate_rows`** — each row gains `pexels_id` / `pexels_url` from the Pexels
video object (`v.get("id")` / `v.get("url")`), alongside the existing `rank`/`query`/
`duration_frames`/`thumb_url`/`link`. This makes the **displayed pool** carry full provenance so
the gate's `pick` / `re_query` ops can stamp it (§5) without a second search. The
`footage_candidates` *table* is unchanged — `store.replace_footage_candidates` writes only its
known columns and ignores extra keys (as it already does for `link`); the extra keys live in the
in-memory / `output_json` pool, which is what `_edit_footage` reads.

**`pipeline/footage._fetch_one`** — populates the `Clip`'s provenance and persists it across the
disk cache, **symmetric with the existing `.frames` sidecar** (operator-chosen approach):

- *Fresh-fetch branch:* unpack the `Selection` from `select_clip`; build the `Clip` with
  `rank`/`pexels_id`/`pexels_url`; after the atomic clip download succeeds, write a
  `footage_<slug>.prov.json` sidecar `{rank, pexels_id, pexels_url}` (only after the clip rename,
  exactly like `.frames`).
- *Disk-cache branch* (`dest.exists()`): read the `.prov.json` sidecar (tolerant of a
  missing/corrupt sidecar → provenance `None`, same posture as `_read_sidecar` for `.frames`) and
  populate the `Clip`'s provenance from it.

This closes the gap that **`regenerate("footage")`** exposes: it forces a footage re-run with
`input_hash=None`, which re-enters `_fetch_one`, which hits the disk cache and never calls
`search()`/`select_clip`. Without the sidecar the re-derived clip would lose its provenance and
`engine.advance` would overwrite a correct row with `None`. With it, a cache-hit clip restores the
exact provenance it was downloaded with.

## 3. Store: the provenance table

A new session table (created by the same idempotent `CREATE TABLE IF NOT EXISTS` migration the
A.1 store already runs on open):

```sql
media_provenance(
  session_id   TEXT    NOT NULL,
  scene_index  INTEGER NOT NULL,   -- the footage scene (beat index)
  source       TEXT    NOT NULL,   -- 'auto' | 'pick' | 're_query'
  query        TEXT,               -- the RESOLVED query that produced the clip
  rank         INTEGER,            -- selected clip's actual pool position (1-based among usable)
  pexels_id    INTEGER,            -- Pexels video object id of the selected clip
  pexels_url   TEXT,               -- Pexels page url of the selected clip
  PRIMARY KEY (session_id, scene_index)
);
```

Two helpers:
- `store.upsert_provenance(conn, session_id, scene_index, *, source, query, rank, pexels_id, pexels_url)`
  — `INSERT … ON CONFLICT(session_id, scene_index) DO UPDATE` (current-state overwrite). **Fails
  loud on an unexpected `source`:** a module-level `_VALID_SOURCES = {"auto", "pick", "re_query"}`
  guard raises `ValueError` before touching the DB, matching the codebase's fail-closed house
  style. The column itself stays plain `TEXT` (forward-compatible — A.2b adds `"uploaded"` to the
  set with **no migration**).
- `store.get_media_provenance(conn, session_id)` → `{scene_index: {source, query, rank, pexels_id, pexels_url}}`.

## 4. Engine + gate stamping

**`engine.advance("footage")`** — after the existing `_sync_footage_candidates_to_db(output)`,
add a `_stamp_auto_provenance(output)` step: for each `clip` in `output["clips"]`, write a
`source="auto"` row from `clip.rank` / `clip.pexels_id` / `clip.pexels_url` / `clip.query`.

**Stamp unconditionally, with nullable rank — a deliberate choice, not a guard side effect.**
`_stamp_auto_provenance` runs *only* inside `advance("footage")`, immediately after `run_footage`
produced fresh **auto** clips (a gate `pick`/`re_query` goes through `_edit_footage`, which never
calls this path), so the clips it reads are always genuinely auto — stamping `source="auto"` is
always consistent with the bound clips, and there is no pick/re_query row to protect. When the
sidecar is present (every clip fetched under A.2a) the rank/Pexels fields are populated; for a
**legacy pre-A.2a cached `.mp4`** with no `.prov.json`, we record `source="auto"` with
`rank`/`pexels_id`/`pexels_url` = `None` ("auto, origin unknown") rather than writing no row at all
— marginally more honest than leaving A.6 to infer a missing scene. The one bounded degradation:
if a sidecar is *externally* deleted mid-session, a re-advance overwrites a previously-known rank
with `None`; nothing in A.2a deletes sidecars, so within a session this does not arise, and the
worst case is a re-fetch restoring it.

**`engine._edit_footage(op)`** — already computes the `chosen` pool row (which now carries
`pexels_id`/`pexels_url` from `candidate_rows`). After it rebinds the scene's `Clip`, stamp the
record:
- `re_query` → `source="re_query"`, `query=q` (the hardened query), `rank`/`pexels_id`/`pexels_url`
  from `chosen` (rank-1 of the fresh search, as `_edit_footage` already selects).
- `pick` → `source="pick"`, `query`/`rank`/`pexels_id`/`pexels_url` from the picked pool row.

Both reuse `store.upsert_provenance`, so an `auto` row is correctly overwritten when the user later
picks or re-queries that scene.

### 4.1 Why provenance-on-`Clip` is invariant-safe (accepted deviation)

The provenance fields ride on the `Clip`, so they are present in the footage `output_json`
(`clips_to_json` serializes all dataclass fields). This is a deliberate, documented deviation from
the brainstorming note's *"provenance never enters any input_hash"* wording — keeping provenance on
the `Clip` is required for clean layering (the pipeline computes it; the session engine, which has
no business re-deriving the selection, simply reads it off the clip to stamp). The consequence is
bounded and harmless:

- **`spec.json` is unaffected** — `assemble.build_spec` ignores the new fields, so the render
  contract is byte-identical (invariant #1). This is the only pinned output; no test pins
  `output_json` bytes or the `input_hash`.
- The footage `output_json` change perturbs assemble's `input_hash` *value* only. Within a session
  the footage output is persisted once and re-loaded deterministically (exact `asdict` ↔
  `Clip(**c)` round-trip), so the hash is normally stable. The one edge: a clip's provenance can
  *flip* across a re-advance (fresh-fetched with provenance, later cache-hit with a missing/stale
  sidecar → `None`), which changes the footage `output_json` and re-runs assemble **once**. That is
  harmless — the re-derive is idempotent, so the resulting `spec.json` is identical — but it is a
  real (rare, sidecar-makes-it-rarer) extra run, not literally nil. The deviation stands because
  the cost ceiling is "one redundant assemble that produces byte-identical output."

The simpler alternative considered and rejected — stripping provenance keys inside `clips_to_json`
to keep `output_json` clean — adds a "serialize-some-but-not-all-`Clip`-fields" special case that a
future dev could silently break, for no invariant benefit.

## 5. Session API + the auto-selection edge cases

**`api.media_provenance(sess)`** → `store.get_media_provenance(sess.conn, sess.id)` →
`{scene_index: {source, query, rank, pexels_id, pexels_url}}`. Thin, read-only, mirrors the other
A.1 API accessors. This is the surface A.6 reads to render badges.

**Edge cases recorded faithfully (the reason `rank` is surfaced, not assumed):**
- *K-floor displacement* — when the most-relevant clip is too short and `select_clip` falls to a
  longer clip below it, `rank` is that lower position (e.g. 2), not 1.
- *Broaden-to-title* — when a too-specific query whiffs and `fetch_footage` retries with the title,
  the chosen clip comes from the **broadened** search; `Clip.query` already records that resolved
  query, and `rank`/`pexels_id`/`pexels_url` come from that same search. The provenance *value* is
  correct — surfaced from the clip, not matched against the pool, which is exactly why "surface"
  beats "link-match." **But this opens a downstream UI gap that A.2a does not close — see below.**

### 5.1 Known A.6 residual — selected clip absent from the displayed pool (broaden-after-whiff only)

A.2a records the provenance value correctly, but it does **not** make the recorded record consistent
with the *displayed candidate pool* in the one broaden-after-whiff case, and that inconsistency
lands at A.6, not here. Stated plainly so it is not buried:

- **The gap:** `run_footage` builds the displayed pool from the scene's specific query (`ps.query`).
  When that query returns zero usable portrait clips, `fetch_footage` broadens to
  `broad_query = harden(title)` and the selected clip comes from the **title** search. So the
  displayed pool (specific query) will **not contain the selected clip**, and the recorded `rank`
  indexes the **broadened** search, not the displayed pool. At A.6 the UI would show a "selected"
  clip that isn't a member of the pool it renders, with a rank that doesn't index that pool.
- **A.6 must handle it** (this is the residual handed forward, not an A.2a fix): either the badge UI
  tolerates "selected clip not in the displayed pool," **or** A.6 persists the *resolved* pool
  (the broadened search's candidates) so the pool it shows is the one the clip and rank actually
  index. Surfacing the resolved pool is deliberately out of A.2a's scope — it is pool *display*,
  not provenance capture.
- **Tight bound — this is broaden-*after-whiff* only.** The query is hardened at **plan time**
  (`recipe.py:177` → `query=harden(beat.keywords or title, title=title)`), so both Layer-A lexicon
  remaps *and* the Layer-B named-entity "degrade to title" have **already** rewritten `ps.query`
  before `run_footage` builds the pool from that same `ps.query`. In those cases the pool is built
  from the very query that produced the clip → **pool matches clip, no gap**. The gap exists only
  when a hardened *specific* query is searched, returns zero usable portrait clips, and is broadened
  at fetch time. Whiffs (zero usable *portrait* clips, not zero results) are rare — so this is
  rare-but-real, and it is an A.6 concern, not an A.2a defect.

## 6. Testing (tests-only; no eyes-on)

- **Footage stage:** `select_clip` returns the correct `Selection` (rank/id/url) for the
  relevance-first pick, the K-floor displacement (rank > 1), and the `first_usable` fallback;
  `candidate_rows` includes `pexels_id`/`pexels_url`; `_fetch_one` writes the `.prov.json` sidecar
  on fresh fetch and **restores provenance from it on a disk-cache hit**; a missing/corrupt sidecar
  degrades to `None` provenance without raising.
- **Broaden-after-whiff provenance** (the §5.1 case): a specific query that yields zero usable
  portrait clips broadens to the title; assert the recorded provenance comes from the **broadened**
  clip — `query` == the (hardened) title and `rank`/`pexels_id`/`pexels_url` index the title search
  — confirming the value is captured from the clip, independent of the displayed pool.
- **Engine:** `advance("footage")` stamps `source="auto"` rows from the clips on the fresh path
  **and** the disk-cache path (rank preserved via the sidecar); a legacy cache hit with **no**
  sidecar stamps `source="auto"` with `rank=None` (the deliberate "auto, origin unknown" record,
  §4); `regenerate("footage")` re-stamps auto from the sidecar rather than nulling a known rank;
  `edit` with `pick` stamps `source="pick"` and `re_query` stamps `source="re_query"`, each
  overwriting the prior `auto` row for that scene.
- **Store:** `upsert_provenance` round-trips and overwrites on PK conflict; **raises `ValueError` on
  an unexpected `source`** (the fail-loud guard, §3); `get_media_provenance` shape; the migration is
  idempotent (open an existing DB twice).
- **API:** `media_provenance` returns the `{scene_index: {...}}` map after autopilot and after a
  gate edit.
- **A.1 regression (invariant #1 pinned on both sides):** the full A.1 suite stays green; the
  golden-autopilot / content-identity test confirms `spec.json` is **byte-identical** both with the
  provenance fields **populated** on the clips **and** with them left `None` — so the render
  contract is pinned for the default path and the captured-provenance path alike.

Build size: **~6–8 TDD tasks**, one branch off `development`, PR → `development`.

## 7. Out of scope (explicit)

User uploads + the `uploaded` source (A.2b); the DeepSeek re-query driver (A.2c); the A.6 badge UI
/ preview API / frontend harness; any credits/attribution feature; edit-history + timestamps; any
`spec.json` contract change. A.2a is the session-only provenance record + its faithful capture only.
