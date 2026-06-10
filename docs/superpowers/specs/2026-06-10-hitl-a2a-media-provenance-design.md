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
- The A.6 badge UI itself, the preview API, and the frontend harness — **A.6**.
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

`rank` mirrors `candidate_rows`' semantics exactly (1-based among *usable* portrait clips, i.e.
`len(usable_so_far) + 1`). The `first_usable` fallback (floor cleared by nothing) carries the
fallback clip's own rank/id/url. Two call sites unpack `select_clip` and must update:
`_fetch_one` (§2 below) and `footage_diagnostic` (it already *re-locates* select_clip's link to
compute a rank — it now reads `.rank` directly, removing a duplicate link-locate). Their tests
update with them.

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
  — `INSERT … ON CONFLICT(session_id, scene_index) DO UPDATE` (current-state overwrite).
- `store.get_media_provenance(conn, session_id)` → `{scene_index: {source, query, rank, pexels_id, pexels_url}}`.

## 4. Engine + gate stamping

**`engine.advance("footage")`** — after the existing `_sync_footage_candidates_to_db(output)`,
add a `_stamp_auto_provenance(output)` step: for each `clip` in `output["clips"]`, write a
`source="auto"` row from `clip.rank` / `clip.pexels_id` / `clip.pexels_url` / `clip.query`. Because
the sidecar (§2) guarantees clips carry provenance on both fresh and disk-cache paths, this stamps
unconditionally; as a belt-and-suspenders guard it skips a clip whose `rank is None` rather than
clobbering an existing row with nulls.

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
  `Clip(**c)` round-trip), so the hash is stable — no spurious cache misses. Even if assemble
  re-ran, it would produce the identical `spec.json` (idempotent re-derive). Net effect: nil.

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
  query, and `rank`/`pexels_id`/`pexels_url` come from that same search. The provenance is correct
  even though the *displayed* candidate pool (built from the specific query in `run_footage`) may
  not contain that clip — provenance is surfaced from the clip, not matched against the pool, which
  is exactly why "surface" beats "link-match."

## 6. Testing (tests-only; no eyes-on)

- **Footage stage:** `select_clip` returns the correct `Selection` (rank/id/url) for the
  relevance-first pick, the K-floor displacement (rank > 1), and the `first_usable` fallback;
  `candidate_rows` includes `pexels_id`/`pexels_url`; `_fetch_one` writes the `.prov.json` sidecar
  on fresh fetch and **restores provenance from it on a disk-cache hit** (the regenerate guard);
  a missing/corrupt sidecar degrades to `None` provenance without raising.
- **Engine:** `advance("footage")` stamps `source="auto"` rows from the clips (fresh path **and**
  the disk-cache path via the sidecar); `regenerate("footage")` preserves provenance rather than
  nulling it; `edit` with `pick` stamps `source="pick"` and `re_query` stamps `source="re_query"`,
  each overwriting the prior `auto` row for that scene.
- **Store:** `upsert_provenance` round-trips and overwrites on PK conflict; `get_media_provenance`
  shape; the migration is idempotent (open an existing DB twice).
- **API:** `media_provenance` returns the `{scene_index: {...}}` map after autopilot and after a
  gate edit.
- **A.1 regression:** the full A.1 suite stays green; the golden-autopilot / content-identity test
  confirms `spec.json` is **byte-identical** with the provenance fields present on the clips.

Build size: **~6–8 TDD tasks**, one branch off `development`, PR → `development`.

## 7. Out of scope (explicit)

User uploads + the `uploaded` source (A.2b); the DeepSeek re-query driver (A.2c); the A.6 badge UI
/ preview API / frontend harness; any credits/attribution feature; edit-history + timestamps; any
`spec.json` contract change. A.2a is the session-only provenance record + its faithful capture only.
