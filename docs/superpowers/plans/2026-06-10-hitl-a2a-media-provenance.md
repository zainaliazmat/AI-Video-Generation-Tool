# HITL A.2a — Per-Scene Media Provenance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record per-footage-scene media provenance (`source` / `query` / `rank` / Pexels `{id,url}`) in the session DB, surfaced from `select_clip`'s real choice, so the future A.6 gate UI can render source badges — without changing `spec.json`.

**Architecture:** Extend the footage pipeline to *surface* its selection (`select_clip` → a `Selection` namedtuple; `Clip` gains optional provenance fields; `_fetch_one` persists them across its disk cache via a `.prov.json` sidecar). The session engine stamps a new `media_provenance` table — `source="auto"` on a footage advance, `pick`/`re_query` on a gate edit — and exposes it through `api.media_provenance`. `spec.json` stays byte-identical because `assemble.build_spec` ignores the new fields.

**Tech Stack:** Python 3.12, stdlib `sqlite3`, `pytest`. Backend package under `backend/` (run pytest from `backend/` via `.venv/bin/python -m pytest`).

**Design doc:** `docs/superpowers/specs/2026-06-10-hitl-a2a-media-provenance-design.md`

**Branch:** `hitl-a2a-media-provenance` (already created off `development`; PR → `development`, never master).

**Test command (from `backend/`):** `.venv/bin/python -m pytest <path> -v`

---

## File Structure

- **Modify** `backend/pipeline/contracts.py` — `Clip` gains 3 optional provenance fields (Task 1).
- **Modify** `backend/pipeline/footage.py` — `Selection` namedtuple + `select_clip` return (Task 2); `candidate_rows` +pexels fields (Task 3); `_fetch_one` provenance + `.prov.json` sidecar helpers (Task 4).
- **Modify** `backend/pipeline/footage_diagnostic.py` — `kfloor_pick` adapts to the namedtuple, keeps its locate loop (Task 2).
- **Modify** `backend/session/store.py` — `media_provenance` table + `upsert_provenance` (fail-loud) + `get_media_provenance` (Task 5).
- **Modify** `backend/session/engine.py` — `_stamp_auto_provenance` + advance wiring (Task 6); `_edit_footage` stamps pick/re_query (Task 7).
- **Modify** `backend/session/api.py` — `media_provenance` getter (Task 8).
- **Tests:** `backend/tests/test_footage.py` (Tasks 1-4), `backend/tests/test_session_store.py` (Task 5), **new** `backend/tests/test_session_provenance.py` (Tasks 6-8), `backend/tests/test_session_autopilot_golden.py` (Task 9).

---

## Task 1: `Clip` gains optional provenance fields

**Files:**
- Modify: `backend/pipeline/contracts.py` (the `Clip` dataclass)
- Test: `backend/tests/test_footage.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_footage.py` (it already has `from pipeline.contracts import Clip, FootageRequest`); add `import dataclasses` at the top of the file:

```python
def test_clip_provenance_fields_default_none_and_roundtrip():
    # Old construction (no provenance) still works — fields default to None.
    bare = Clip(index=0, query="q", path="assets/x.mp4", duration_frames=180)
    assert bare.rank is None and bare.pexels_id is None and bare.pexels_url is None

    # New construction carries provenance, and asdict<->Clip(**d) round-trips it
    # (this IS the mechanism session/codecs.clips_to_json/from_json rely on).
    c = Clip(index=1, query="reef", path="assets/r.mp4", duration_frames=210,
             rank=2, pexels_id=12345, pexels_url="https://pexels.com/v/12345")
    d = dataclasses.asdict(c)
    assert d["rank"] == 2 and d["pexels_id"] == 12345 and d["pexels_url"] == "https://pexels.com/v/12345"
    assert Clip(**d) == c
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_footage.py::test_clip_provenance_fields_default_none_and_roundtrip -v`
Expected: FAIL with `TypeError: __init__() got an unexpected keyword argument 'rank'`

- [ ] **Step 3: Write minimal implementation**

In `backend/pipeline/contracts.py`, extend the `Clip` dataclass (currently ends at `duration_frames`):

```python
@dataclass
class Clip:
    index: int  # beat index (scene position) this clip belongs to
    query: str
    path: str  # relative to remotion/public/, e.g. "assets/footage_ab12cd34.mp4"
    duration_frames: int | None = None  # clip length; None if unknown (no loop fallback)
    # A.2a media provenance — surfaced from select_clip's real choice; None until set
    # (and for legacy pre-A.2a cached clips). Render-irrelevant: assemble ignores these.
    rank: int | None = None          # 1-based position among USABLE clips in the chosen search
    pexels_id: int | None = None     # Pexels video object id of the chosen clip
    pexels_url: str | None = None    # Pexels page url of the chosen clip
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_footage.py::test_clip_provenance_fields_default_none_and_roundtrip -v`
Expected: PASS

- [ ] **Step 5: Run the full footage + session suites to confirm no regression**

Run: `.venv/bin/python -m pytest tests/test_footage.py tests/test_session_autopilot_golden.py tests/test_session_footage_gate.py -q`
Expected: PASS (the optional fields with defaults keep every existing `Clip(...)` construction and codec round-trip working)

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/contracts.py backend/tests/test_footage.py
git commit -m "feat(a2a): Clip gains optional media-provenance fields"
```

---

## Task 2: `select_clip` returns a `Selection` (surface the real choice)

**Files:**
- Modify: `backend/pipeline/footage.py:73-97` (`select_clip`) + add the `Selection` namedtuple
- Modify: `backend/pipeline/footage_diagnostic.py:64-76` (`kfloor_pick`)
- Test: `backend/tests/test_footage.py` (add new assertions; update 5 existing unpackings)

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_footage.py`. The `_video(link, duration)` helper has no `id`/`url`, so add a provenance-carrying helper next to it:

```python
def _video_pid(link, duration, pid, purl):
    v = _video(link, duration)
    v["id"] = pid
    v["url"] = purl
    return v


def test_select_clip_surfaces_rank_and_pexels_origin():
    sel = select_clip([_video_pid("a", 6, 101, "https://pexels.com/v/101")], min_frames=0, fps=30)
    assert sel.link == "a" and sel.duration_frames == 180
    assert sel.rank == 1 and sel.pexels_id == 101 and sel.pexels_url == "https://pexels.com/v/101"


def test_select_clip_rank_is_kfloor_displaced_position():
    # The 1s top clip is below the 60f floor; select_clip drops to the 17s clip at
    # usable-rank 2 — provenance rank must be 2, not 1.
    sel = select_clip([_video_pid("one_second", 1, 11, "u11"),
                       _video_pid("seventeen_second", 17, 22, "u22")], min_frames=60, fps=30)
    assert sel.link == "seventeen_second" and sel.rank == 2 and sel.pexels_id == 22


def test_select_clip_fallback_carries_first_usable_origin():
    # Nothing clears the floor -> fall back to the first usable clip (rank 1) and carry
    # ITS origin.
    sel = select_clip([_video_pid("a", 1, 7, "u7"), _video_pid("b", 2, 8, "u8")],
                      min_frames=999, fps=30)
    assert sel.link == "a" and sel.rank == 1 and sel.pexels_id == 7
```

Also UPDATE the 5 existing unpackings in this file (lines for `test_select_clip_returns_link_and_duration_frames`, `..._relevance_wins...`, `..._skips_pathologically_short...`, `..._falls_back_to_first...`, `..._handles_missing_duration`) from `link, dur_f = select_clip(...)` to attribute access. Example for the first one:

```python
def test_select_clip_returns_link_and_duration_frames():
    sel = select_clip([_video("a", 6)], min_frames=0, fps=30)
    assert sel.link == "a"
    assert sel.duration_frames == 180  # 6s * 30fps
```

Apply the same `sel = select_clip(...)` / `sel.link` / `sel.duration_frames` rewrite to the other four (keeping each test's existing assertions on link and duration).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `.venv/bin/python -m pytest tests/test_footage.py::test_select_clip_surfaces_rank_and_pexels_origin -v`
Expected: FAIL with `AttributeError: 'tuple' object has no attribute 'link'`

- [ ] **Step 3: Write the implementation**

In `backend/pipeline/footage.py`, add the namedtuple import and the `Selection` type near the top (after the existing imports), and rewrite `select_clip`:

```python
from collections import namedtuple

# select_clip's surfaced choice: link/duration as before, plus the chosen clip's
# usable-rank (1-based among USABLE clips, matching candidate_rows) and Pexels origin.
Selection = namedtuple("Selection", "link duration_frames rank pexels_id pexels_url")
```

```python
def select_clip(videos, *, min_frames=0, fps):
    """Return a Selection for the most relevant usable clip, subject to a SOFT loop
    floor (see FootageRequest). Surfaces the chosen clip's usable-rank (1-based among
    usable portrait clips — the same metric candidate_rows reports) and Pexels id/url
    so provenance is captured from the real choice, never link-matched.
    """
    first_usable = None
    usable_rank = 0
    for v in videos:
        link = pick_video_file(v.get("video_files", []))
        if not link:
            continue
        usable_rank += 1
        frames = _video_duration_frames(v, fps)
        sel = Selection(link, frames, usable_rank, v.get("id"), v.get("url"))
        if first_usable is None:
            first_usable = sel
        if frames is None or frames >= min_frames:
            return sel
    return first_usable if first_usable is not None else Selection(None, None, None, None, None)
```

Then update the in-pipeline caller `_fetch_one` (currently `url, duration_frames = select_clip(...)` at line ~156) to unpack from the Selection — minimal change for now (Task 4 expands it):

```python
        sel = select_clip(data.get("videos", []), min_frames=req.min_frames, fps=fps)
        url, duration_frames = sel.link, sel.duration_frames
        if not url:
            return None
```

And update `backend/pipeline/footage_diagnostic.py` `kfloor_pick` to read from the namedtuple while KEEPING its all-videos locate loop (different rank metric — do not use `sel.rank`):

```python
def kfloor_pick(videos, *, min_frames, fps):
    """(rank, frames) the REAL select_clip renders under the loop floor — computed by
    CALLING select_clip and locating its link in the ranked list, never a reimpl. The
    rank here is ALL-VIDEOS position (matches summarize_candidates), distinct from
    select_clip's usable-only Selection.rank, so we keep the link-locate."""
    sel = select_clip(videos, min_frames=min_frames, fps=fps)
    if sel.link is None:
        return None, None
    for rank, v in enumerate(videos, 1):
        if pick_video_file(v.get("video_files", [])) == sel.link:
            return rank, sel.duration_frames
    return None, sel.duration_frames
```

- [ ] **Step 4: Run the footage + diagnostic suites to verify green**

Run: `.venv/bin/python -m pytest tests/test_footage.py tests/test_footage_diagnostic.py tests/test_footage_relevance.py -q`
Expected: PASS (new provenance assertions pass; the 5 updated unpackings pass; `kfloor_pick`'s `(rank, frames)` contract is unchanged so diagnostic tests stay green)

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/footage.py backend/pipeline/footage_diagnostic.py backend/tests/test_footage.py
git commit -m "feat(a2a): select_clip surfaces chosen rank + Pexels origin via Selection"
```

---

## Task 3: `candidate_rows` carries Pexels id/url

**Files:**
- Modify: `backend/pipeline/footage.py:56-70` (`candidate_rows`)
- Test: `backend/tests/test_footage.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_footage.py` (uses the `_video_pid` helper from Task 2; add `from pipeline.footage import candidate_rows` to the imports):

```python
def test_candidate_rows_include_pexels_origin():
    rows = candidate_rows([_video_pid("a", 6, 101, "https://pexels.com/v/101")],
                          query="coral reef", fps=30)
    assert len(rows) == 1
    r = rows[0]
    assert r["rank"] == 1 and r["query"] == "coral reef"
    assert r["pexels_id"] == 101 and r["pexels_url"] == "https://pexels.com/v/101"
    assert r["link"] == "a"  # existing fields preserved
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_footage.py::test_candidate_rows_include_pexels_origin -v`
Expected: FAIL with `KeyError: 'pexels_id'`

- [ ] **Step 3: Write the implementation**

In `backend/pipeline/footage.py`, extend the row dict in `candidate_rows`:

```python
        rows.append({"rank": len(rows) + 1, "query": query,
                     "duration_frames": _video_duration_frames(v, fps),
                     "thumb_url": thumb, "link": link,
                     "pexels_id": v.get("id"), "pexels_url": v.get("url")})
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_footage.py::test_candidate_rows_include_pexels_origin -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/footage.py backend/tests/test_footage.py
git commit -m "feat(a2a): candidate_rows carry Pexels id/url for pool provenance"
```

---

## Task 4: `_fetch_one` populates provenance + `.prov.json` sidecar

**Files:**
- Modify: `backend/pipeline/footage.py` (add `import json`; add sidecar helpers; populate `Clip` in `_fetch_one`)
- Test: `backend/tests/test_footage.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_footage.py` (uses `fetch_footage`, `FootageRequest` already imported; add `from pipeline.footage import query_slug` and `from pathlib import Path`):

```python
def test_fetch_one_populates_clip_provenance_and_writes_sidecar(tmp_path):
    vids = {"videos": [_video_pid("x.mp4", 6, 7, "https://pexels.com/v/7")]}
    calls = {"n": 0}

    def fake_search(q, key):
        calls["n"] += 1
        return vids

    dl = lambda url, dest: Path(dest).write_bytes(b"v")
    req = FootageRequest(index=0, query="q", min_frames=0)

    c1 = fetch_footage([req], tmp_path, fps=30, key="K", search=fake_search, downloader=dl)[0]
    assert c1.rank == 1 and c1.pexels_id == 7 and c1.pexels_url == "https://pexels.com/v/7"
    assert (tmp_path / f"footage_{query_slug('q')}.prov.json").exists()

    # Second fetch hits the disk cache: search NOT called again; provenance restored
    # from the sidecar (this is the regenerate-safe path).
    c2 = fetch_footage([req], tmp_path, fps=30, key="K", search=fake_search, downloader=dl)[0]
    assert calls["n"] == 1  # no re-search
    assert c2.rank == 1 and c2.pexels_id == 7 and c2.pexels_url == "https://pexels.com/v/7"


def test_fetch_one_missing_prov_sidecar_degrades_to_none(tmp_path):
    # A legacy pre-A.2a cached clip (clip file present, no .prov.json) must yield None
    # provenance without raising or re-searching.
    slug = query_slug("legacy")
    (tmp_path / f"footage_{slug}.mp4").write_bytes(b"v")

    def boom(q, key):
        raise AssertionError("must not search when the clip is already cached")

    req = FootageRequest(index=0, query="legacy", min_frames=0)
    c = fetch_footage([req], tmp_path, fps=30, key="K", search=boom,
                      downloader=lambda u, d: None)[0]
    assert c.rank is None and c.pexels_id is None and c.pexels_url is None


def test_fetch_footage_broaden_surfaces_broadened_provenance(tmp_path):
    # §5.1: a specific query with zero usable portrait clips broadens to the title;
    # provenance must come from the BROADENED clip (query=title, rank/origin from it).
    def fake_search(query, key):
        if query == "specific":
            return {"videos": []}  # whiff
        return {"videos": [_video_pid("broad.mp4", 6, 555, "https://pexels.com/v/555")]}

    req = FootageRequest(index=0, query="specific", min_frames=0, broad_query="title")
    c = fetch_footage([req], tmp_path, fps=30, key="K", search=fake_search,
                      downloader=lambda url, dest: Path(dest).write_bytes(b"v"))[0]
    assert c.query == "title"  # resolved (broadened) query recorded
    assert c.rank == 1 and c.pexels_id == 555 and c.pexels_url == "https://pexels.com/v/555"
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_footage.py::test_fetch_one_populates_clip_provenance_and_writes_sidecar -v`
Expected: FAIL (`c1.rank` is `None` — `_fetch_one` doesn't set provenance yet, and no `.prov.json` is written)

- [ ] **Step 3: Write the implementation**

In `backend/pipeline/footage.py`: add `import json` to the imports block (it currently imports `hashlib, os, time`, not `json`). Add two sidecar helpers next to the existing `_read_sidecar`:

```python
def _write_prov_sidecar(path, rank, pexels_id, pexels_url) -> None:
    path.write_text(json.dumps({"rank": rank, "pexels_id": pexels_id, "pexels_url": pexels_url}))


def _read_prov_sidecar(path):
    """(rank, pexels_id, pexels_url) from the sidecar, or (None, None, None) when it is
    absent/corrupt — mirrors _read_sidecar's tolerant posture for legacy cached clips."""
    try:
        d = json.loads(path.read_text())
        return d.get("rank"), d.get("pexels_id"), d.get("pexels_url")
    except (OSError, ValueError):
        return None, None, None
```

Rewrite `_fetch_one` to thread provenance through both the cache-hit and fresh-fetch branches:

```python
def _fetch_one(req, query, out_dir, *, fps, key, search, downloader):
    """Cache-or-fetch one clip for `query`. Returns a Clip, or None when the search
    yields no usable portrait clip (so the caller can broaden). Caches by query slug;
    a `.frames` sidecar preserves the duration and a `.prov.json` sidecar preserves the
    A.2a provenance (rank + Pexels id/url) across the download cache."""
    slug = query_slug(query)
    dest = out_dir / f"footage_{slug}.mp4"
    sidecar = out_dir / f"footage_{slug}.frames"
    prov_sidecar = out_dir / f"footage_{slug}.prov.json"

    if dest.exists():
        duration_frames = _read_sidecar(sidecar)  # may be None if unknown
        rank, pexels_id, pexels_url = _read_prov_sidecar(prov_sidecar)  # None,None,None if legacy
    else:
        data = search(query, key)
        sel = select_clip(data.get("videos", []), min_frames=req.min_frames, fps=fps)
        url, duration_frames = sel.link, sel.duration_frames
        rank, pexels_id, pexels_url = sel.rank, sel.pexels_id, sel.pexels_url
        if not url:
            return None
        # Atomic write: stream into a sibling .part, then os.replace onto dest only
        # on success. A truncated .part is unlinked and never becomes a cached dest.
        tmp = dest.parent / (dest.name + ".part")
        try:
            downloader(url, tmp)
            os.replace(tmp, dest)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        if duration_frames is not None:
            sidecar.write_text(str(duration_frames))  # only AFTER the rename
        _write_prov_sidecar(prov_sidecar, rank, pexels_id, pexels_url)  # only AFTER the rename

    return Clip(index=req.index, query=query, path=f"assets/{dest.name}",
                duration_frames=duration_frames, rank=rank,
                pexels_id=pexels_id, pexels_url=pexels_url)
```

(Note: the `sel = select_clip(...)` line replaces the minimal unpack added in Task 2 Step 3.)

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_footage.py -q`
Expected: PASS (all footage tests, including the three new provenance/sidecar/broaden tests)

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/footage.py backend/tests/test_footage.py
git commit -m "feat(a2a): _fetch_one captures provenance + .prov.json sidecar (regenerate-safe)"
```

---

## Task 5: `media_provenance` store table + helpers (fail-loud source)

**Files:**
- Modify: `backend/session/store.py` (add table to `_SCHEMA`; add `_VALID_SOURCES`, `upsert_provenance`, `get_media_provenance`)
- Test: `backend/tests/test_session_store.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_session_store.py` (it has `from session import store`; add `import pytest`):

```python
def test_media_provenance_table_created_idempotently(tmp_path):
    db = tmp_path / "s.db"
    store.connect(db).close()
    c2 = store.connect(db)  # reopening an existing DB must not error
    tables = {r[0] for r in c2.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    c2.close()
    assert "media_provenance" in tables


def test_media_provenance_roundtrip_and_overwrite(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.upsert_provenance(conn, "s1", 1, source="auto", query="coral reef", rank=1,
                            pexels_id=101, pexels_url="u101")
    assert store.get_media_provenance(conn, "s1") == {
        1: {"source": "auto", "query": "coral reef", "rank": 1,
            "pexels_id": 101, "pexels_url": "u101"}}
    # current-state overwrite on PK conflict (one row per scene)
    store.upsert_provenance(conn, "s1", 1, source="pick", query="coral reef", rank=2,
                            pexels_id=102, pexels_url="u102")
    got = store.get_media_provenance(conn, "s1")
    assert got[1]["source"] == "pick" and got[1]["rank"] == 2 and len(got) == 1
    conn.close()


def test_upsert_provenance_rejects_unknown_source(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    with pytest.raises(ValueError, match="unknown provenance source"):
        store.upsert_provenance(conn, "s1", 0, source="bogus", query="q", rank=1,
                                pexels_id=1, pexels_url="u")
    conn.close()


def test_upsert_provenance_allows_null_rank_for_legacy_clip(tmp_path):
    conn = store.connect(tmp_path / "s.db")
    store.upsert_provenance(conn, "s1", 0, source="auto", query="q", rank=None,
                            pexels_id=None, pexels_url=None)
    assert store.get_media_provenance(conn, "s1")[0]["rank"] is None
    conn.close()
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_session_store.py::test_media_provenance_roundtrip_and_overwrite -v`
Expected: FAIL with `AttributeError: module 'session.store' has no attribute 'upsert_provenance'`

- [ ] **Step 3: Write the implementation**

In `backend/session/store.py`, append the new table to the `_SCHEMA` string (inside the triple-quoted block, after `footage_candidates`):

```sql
CREATE TABLE IF NOT EXISTS media_provenance (
  session_id  TEXT    NOT NULL,
  scene_index INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  query       TEXT,
  rank        INTEGER,
  pexels_id   INTEGER,
  pexels_url  TEXT,
  PRIMARY KEY (session_id, scene_index)
);
```

Add the guard constant and helpers (e.g. after `set_candidate_clip_path`):

```python
# A.2a provenance sources. Fail loud on anything else (house style); A.2b adds
# "uploaded" here with NO migration — the column is plain TEXT, forward-compatible.
_VALID_SOURCES = {"auto", "pick", "re_query"}


def upsert_provenance(conn, session_id, scene_index, *, source, query, rank,
                      pexels_id, pexels_url) -> None:
    """Record current-state provenance for one footage scene (one row per scene)."""
    if source not in _VALID_SOURCES:
        raise ValueError(
            f"unknown provenance source {source!r} (valid: {sorted(_VALID_SOURCES)})")
    conn.execute(
        "INSERT INTO media_provenance"
        " (session_id, scene_index, source, query, rank, pexels_id, pexels_url)"
        " VALUES (?,?,?,?,?,?,?)"
        " ON CONFLICT(session_id, scene_index) DO UPDATE SET"
        " source=excluded.source, query=excluded.query, rank=excluded.rank,"
        " pexels_id=excluded.pexels_id, pexels_url=excluded.pexels_url",
        (session_id, scene_index, source, query, rank, pexels_id, pexels_url),
    )
    conn.commit()


def get_media_provenance(conn, session_id):
    """{scene_index: {source, query, rank, pexels_id, pexels_url}} for the session."""
    rows = conn.execute(
        "SELECT scene_index, source, query, rank, pexels_id, pexels_url"
        " FROM media_provenance WHERE session_id=? ORDER BY scene_index",
        (session_id,)).fetchall()
    return {r["scene_index"]: {"source": r["source"], "query": r["query"], "rank": r["rank"],
                               "pexels_id": r["pexels_id"], "pexels_url": r["pexels_url"]}
            for r in rows}
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_session_store.py -q`
Expected: PASS (new provenance tests + all existing store tests; the idempotent-schema test now also implicitly covers the new table)

- [ ] **Step 5: Commit**

```bash
git add backend/session/store.py backend/tests/test_session_store.py
git commit -m "feat(a2a): media_provenance table + fail-loud upsert/get helpers"
```

---

## Task 6: Engine stamps `source="auto"` on footage advance

**Files:**
- Modify: `backend/session/engine.py` (add `_stamp_auto_provenance`; call it in `advance` after `_sync_footage_candidates_to_db`)
- Test: **new** `backend/tests/test_session_provenance.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_session_provenance.py`. The `_seed` helper mirrors `test_session_footage_gate._seed` but adds Pexels `id`/`url` to the pool videos so provenance is non-None:

```python
"""HITL A.2a — per-scene media provenance is stamped to the session DB (source/query/
rank/pexels id+url): `auto` on a footage advance, `pick`/`re_query` on a gate edit.
spec.json is unaffected (proven separately in test_session_autopilot_golden.py)."""
from pathlib import Path

from schema import Theme
from pipeline.content import Beat, BeatsScript
from pipeline.contracts import LineOffset, WordTiming, Clip
from pipeline import validate as validate_stage
from session import store, engine, executors

_TEMPLATES = Path(__file__).resolve().parents[2] / "templates"


def _seed(tmp_path, monkeypatch):
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

    def _vid(link, dur, pid, purl):
        return {"id": pid, "url": purl, "duration": dur,
                "video_files": [{"link": link, "width": 1080, "height": 1920,
                                 "file_type": "video/mp4"}],
                "video_pictures": [{"picture": f"thumb-{pid}"}]}

    pools = {
        "coral reef": [_vid("first.mp4", 6, 101, "https://pexels.com/v/101"),
                       _vid("second.mp4", 9, 102, "https://pexels.com/v/102")],
        "reef shark": [_vid("shark.mp4", 7, 201, "https://pexels.com/v/201")],
    }
    monkeypatch.setattr("pipeline.footage.search_pexels", lambda q, key: {"videos": pools.get(q, [])})
    monkeypatch.setattr("pipeline.footage._download", lambda url, dest: Path(dest).write_bytes(b"v"))
    monkeypatch.setattr("pipeline.footage.require_env", lambda name: "KEY")

    catalog = validate_stage.load_catalog(_TEMPLATES)
    ctx = executors.EngineContext(
        topic="Reefs", fps=30, theme=Theme(), catalog=catalog, assets_dir=tmp_path / "a",
        cache_dir=tmp_path / "c", voiceover_path=tmp_path / "a" / "v.wav",
        spec_out=tmp_path / "spec.json", sources_out=tmp_path / "src.json")
    conn = store.connect(tmp_path / "s.db")
    store.create_session(conn, id="s1", topic="Reefs", now="t0")
    eng = engine.Engine(conn, ctx, session_id="s1")
    eng.run_all()
    return conn, eng


def test_autopilot_stamps_auto_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "auto", "query": "coral reef", "rank": 1,
                       "pexels_id": 101, "pexels_url": "https://pexels.com/v/101"}
    conn.close()


def test_stamp_auto_records_unknown_origin_for_legacy_clip(tmp_path, monkeypatch):
    # A clip with no surfaced provenance (legacy pre-sidecar cache) is recorded as
    # "auto, origin unknown" (rank/pexels None) rather than leaving no row — the
    # deliberate §4 choice, not a guard side effect.
    conn, eng = _seed(tmp_path, monkeypatch)
    eng._stamp_auto_provenance({"clips": [
        Clip(index=1, query="q", path="assets/x.mp4", duration_frames=180)]})
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1]["source"] == "auto" and prov[1]["rank"] is None and prov[1]["pexels_id"] is None
    conn.close()
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_session_provenance.py::test_autopilot_stamps_auto_provenance -v`
Expected: FAIL (`KeyError: 1` — no provenance stamped yet; `_stamp_auto_provenance` does not exist)

- [ ] **Step 3: Write the implementation**

In `backend/session/engine.py`, call the new method inside `advance` (the existing `if stage == "footage":` block) and add the method:

```python
        if stage == "footage":
            self._sync_footage_candidates_to_db(output)
            self._stamp_auto_provenance(output)
        return output
```

```python
    def _stamp_auto_provenance(self, footage_output):
        """Record source='auto' provenance for each clip from its surfaced origin.
        Runs ONLY here (advance -> run_footage produced fresh auto clips); a gate
        pick/re_query goes through _edit_footage, which stamps its own source. rank/
        pexels are None for a legacy pre-sidecar cached clip ('auto, origin unknown')."""
        for clip in footage_output.get("clips", []):
            store.upsert_provenance(
                self.conn, self.sid, clip.index, source="auto", query=clip.query,
                rank=clip.rank, pexels_id=clip.pexels_id, pexels_url=clip.pexels_url)
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_session_provenance.py -q`
Expected: PASS (both auto tests)

- [ ] **Step 5: Run the A.1 session suites to confirm no regression**

Run: `.venv/bin/python -m pytest tests/test_session_footage_gate.py tests/test_session_autopilot_golden.py tests/test_session_stages.py -q`
Expected: PASS (stamping writes only to `media_provenance`; spec.json and stage flow are untouched)

- [ ] **Step 6: Commit**

```bash
git add backend/session/engine.py backend/tests/test_session_provenance.py
git commit -m "feat(a2a): engine stamps auto provenance on footage advance"
```

---

## Task 7: Gate edits stamp `pick` / `re_query` provenance

**Files:**
- Modify: `backend/session/engine.py` (`_edit_footage` — stamp after rebinding the clip)
- Test: `backend/tests/test_session_provenance.py`

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_session_provenance.py`:

```python
def test_pick_stamps_pick_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    eng.edit("footage", {"op": "pick", "scene_index": 1, "rank": 2})
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "pick", "query": "coral reef", "rank": 2,
                       "pexels_id": 102, "pexels_url": "https://pexels.com/v/102"}
    conn.close()


def test_requery_stamps_requery_provenance(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    eng.edit("footage", {"op": "re_query", "scene_index": 1, "query": "reef shark"})
    prov = store.get_media_provenance(conn, "s1")
    assert prov[1] == {"source": "re_query", "query": "reef shark", "rank": 1,
                       "pexels_id": 201, "pexels_url": "https://pexels.com/v/201"}
    conn.close()
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_session_provenance.py::test_pick_stamps_pick_provenance -v`
Expected: FAIL (provenance row for scene 1 is still `source="auto"` from the seed's run_all — the edit doesn't stamp yet)

- [ ] **Step 3: Write the implementation**

In `backend/session/engine.py` `_edit_footage`, after the final `store.upsert_stage(... "footage" ...)` call (the method's last statement), add the stamp. Both branches expose the resolved query and origin on `chosen` (`re_query` built it via `candidate_rows(query=q)`, so `chosen["query"] == q`; `pick` read it from the persisted pool, which carries `pexels_id`/`pexels_url` from Task 3):

```python
        store.upsert_provenance(
            self.conn, self.sid, scene,
            source="re_query" if op["op"] == "re_query" else "pick",
            query=chosen["query"], rank=chosen["rank"],
            pexels_id=chosen.get("pexels_id"), pexels_url=chosen.get("pexels_url"))
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_session_provenance.py -q`
Expected: PASS (auto + pick + re_query)

- [ ] **Step 5: Run the footage-gate regression**

Run: `.venv/bin/python -m pytest tests/test_session_footage_gate.py -q`
Expected: PASS (the edit ops' existing behavior — swap, pool replace, timing-unchanged — is unaffected)

- [ ] **Step 6: Commit**

```bash
git add backend/session/engine.py backend/tests/test_session_provenance.py
git commit -m "feat(a2a): footage gate edits stamp pick/re_query provenance"
```

---

## Task 8: `api.media_provenance` getter

**Files:**
- Modify: `backend/session/api.py`
- Test: `backend/tests/test_session_provenance.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_session_provenance.py`:

```python
def test_api_media_provenance_getter(tmp_path, monkeypatch):
    conn, eng = _seed(tmp_path, monkeypatch)
    from session import api
    sess = api.Session(conn=conn, engine=eng, id="s1")
    prov = api.media_provenance(sess)
    assert prov[1]["source"] == "auto" and prov[1]["rank"] == 1 and prov[1]["pexels_id"] == 101
    conn.close()
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_session_provenance.py::test_api_media_provenance_getter -v`
Expected: FAIL with `AttributeError: module 'session.api' has no attribute 'media_provenance'`

- [ ] **Step 3: Write the implementation**

In `backend/session/api.py`, add (after the `regenerate` function, before `close`):

```python
def media_provenance(sess: Session):
    """Per-scene media provenance for the A.6 badge UI:
    {scene_index: {source, query, rank, pexels_id, pexels_url}}."""
    return store.get_media_provenance(sess.conn, sess.id)
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_session_provenance.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/session/api.py backend/tests/test_session_provenance.py
git commit -m "feat(a2a): api.media_provenance read accessor"
```

---

## Task 9: Regression — `spec.json` byte-identical regardless of provenance

**Files:**
- Test: `backend/tests/test_session_autopilot_golden.py` (add one test)

- [ ] **Step 1: Write the test (the invariant-#1 pin)**

Add to `backend/tests/test_session_autopilot_golden.py` (it already imports `json`, `Path`, `Clip`, `Theme`, `validate_stage`, and defines `_install_fakes` + `_TEMPLATES`):

```python
def test_autopilot_spec_identical_regardless_of_clip_provenance(tmp_path, monkeypatch):
    """Invariant #1: provenance fields on Clip NEVER change spec.json. Run the engine
    with clips carrying provenance vs. clips without, and assert byte-equal spec.json —
    pinning the render contract for both the default path and the captured-provenance path."""
    from session import store, engine, executors
    catalog = validate_stage.load_catalog(_TEMPLATES)

    def run_with(fetch_fake, sub):
        _install_fakes(monkeypatch)
        monkeypatch.setattr("pipeline.footage.fetch_footage", fetch_fake)
        d = tmp_path / sub
        ctx = executors.EngineContext(
            topic="Coral Reefs", fps=30, theme=Theme(), catalog=catalog,
            assets_dir=d / "assets", cache_dir=d / "c",
            voiceover_path=d / "assets" / "voiceover.wav",
            spec_out=d / "spec.json", sources_out=d / "sources.json")
        conn = store.connect(d / "s.db")
        store.create_session(conn, id="s1", topic="Coral Reefs", now="t0")
        engine.Engine(conn, ctx, session_id="s1").run_all()
        conn.close()
        return (d / "spec.json").read_text()

    def plain(reqs, out_dir, *, fps=30, **kw):
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4",
                     duration_frames=300) for r in reqs]

    def with_prov(reqs, out_dir, *, fps=30, **kw):
        return [Clip(index=r.index, query=r.query, path=f"assets/f{r.index}.mp4",
                     duration_frames=300, rank=3, pexels_id=999,
                     pexels_url="https://pexels.com/v/999") for r in reqs]

    assert run_with(plain, "plain") == run_with(with_prov, "prov")
```

- [ ] **Step 2: Run to verify it passes immediately**

Run: `.venv/bin/python -m pytest tests/test_session_autopilot_golden.py::test_autopilot_spec_identical_regardless_of_clip_provenance -v`
Expected: PASS (this is a guard, not a red→green driver — `assemble.build_spec` already ignores the provenance fields; the test proves and locks it). If it FAILS, a provenance field leaked into the spec — stop and fix `assemble`/codecs before proceeding.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_session_autopilot_golden.py
git commit -m "test(a2a): pin spec.json byte-identity across clip provenance"
```

---

## Final Verification

- [ ] **Run the full backend suite**

Run (from `backend/`): `.venv/bin/python -m pytest -q`
Expected: PASS — 218 prior tests + the new A.2a tests, all green.

- [ ] **Confirm spec.json contract is untouched at the type level**

Run: `.venv/bin/python -m pytest tests/test_session_autopilot_golden.py tests/test_assemble.py -q`
Expected: PASS (golden autopilot + assemble shape unchanged).

- [ ] **Push + open PR**

```bash
git push -u origin hitl-a2a-media-provenance
```
Then hand the operator the compare URL for a PR into `development` (`gh` is not installed; never target master). Tests-only — no eyes-on gate.

---

## Self-Review (completed by plan author)

**1. Spec coverage** — every design section maps to a task:
- §2 `Clip` fields → Task 1; `select_clip`→`Selection` + `footage_diagnostic` → Task 2; `candidate_rows` pexels → Task 3; `_fetch_one` + sidecar → Task 4.
- §3 store table + helpers + fail-loud source → Task 5.
- §4 auto stamp (always-stamp, nullable rank) → Task 6; §4 pick/re_query stamp → Task 7.
- §5 API getter → Task 8; §5.1 broaden-after-whiff provenance → Task 4 (`test_fetch_footage_broaden_surfaces_broadened_provenance`).
- §6 testing → distributed across all tasks; the byte-identity-both-ways pin → Task 9.
- §1/§4.1 invariant (spec.json byte-identical) → Task 9 + the full-suite final check.

**2. Placeholder scan** — none. Every code/test step shows complete code; every run step shows the exact command + expected result.

**3. Type consistency** — `Selection(link, duration_frames, rank, pexels_id, pexels_url)` used identically in Task 2 (definition), Task 4 (`sel.link`/`sel.rank`/`sel.pexels_id`/`sel.pexels_url`). `upsert_provenance(conn, session_id, scene_index, *, source, query, rank, pexels_id, pexels_url)` signature matches its three call sites (Task 6 `_stamp_auto_provenance`, Task 7 `_edit_footage`, and the Task 5 tests). `get_media_provenance` return shape `{scene_index: {source, query, rank, pexels_id, pexels_url}}` matches the Task 6/7/8 assertions. `Clip` provenance field names (`rank`/`pexels_id`/`pexels_url`) are consistent from Task 1 through Tasks 4/6/9.
