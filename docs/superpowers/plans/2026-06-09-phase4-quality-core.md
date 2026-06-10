# Phase-4 Quality Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the paused Phase-4 quality core so the autopilot pipeline produces relevant imagery for arbitrary subjects — killing both `video__7_` defects (typewriter-for-Antikythera, enumeration bare-dots) and the footage-download corrupt-cache landmine.

**Architecture:** Three independent items on branch `enumeration-visual-tier2`. Item 3 hardens `footage.py` downloads (atomic temp→rename + bounded 429/5xx backoff). Item 1 adds a pure deterministic `footage_query.harden()` pass (frozen collision lexicon + conservative named-entity guard) wired into the recipe's query seam. Item 2 replaces the enumeration bare-dot floor with a first-letter monogram (hero) + clean `circle` glyph (list). No `spec.json` contract changes.

**Tech Stack:** Python 3.12 (`backend/.venv`, pytest), TypeScript/React (Remotion templates, vitest), git.

**Build order:** Item 3 (logic-only) → Item 1 (logic + render gate) → Item 2 (logic + render gate).

**Design doc:** `docs/superpowers/specs/2026-06-09-phase4-quality-core-design.md`

**Conventions for every task:**
- Run backend tests with `backend/.venv/bin/python -m pytest <path> -v`.
- Run vitest from the `remotion/` directory: `cd remotion && npx vitest run <path>`.
- Commit on `enumeration-visual-tier2` only. NEVER `development`/`master`. End each commit message with the `Co-Authored-By` trailer (see Task 1 Step 5).
- Do NOT push or open the PR. The PR → `development` waits for the reviewer's explicit go AFTER the two render-gate rulings (Tasks 7 and 11).

---

## ITEM 3 — Footage download hardening (logic-only)

Files in play:
- Modify: `backend/pipeline/footage.py`
- Test: `backend/tests/test_footage_relevance.py` (existing) + a new `backend/tests/test_footage_download.py`

### Task 1: Atomic download (temp → rename) at the `_fetch_one` level

**Files:**
- Modify: `backend/pipeline/footage.py:107-126` (`_fetch_one`), add `import os` at the top
- Test: `backend/tests/test_footage_download.py` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_footage_download.py`:

```python
"""Item 3 — footage download hardening: atomic temp→rename + 429/5xx backoff.

The corrupt-cache landmine: _download streamed straight into `dest`, so a
mid-stream drop left a truncated file that the `if dest.exists()` cache check
later served as valid. The fix downloads to a sibling `.part` and os.replace()s
it onto `dest` only on success; the `.frames` sidecar is written only AFTER the
rename. These tests pin that a failed download leaves NO dest and NO sidecar, and
that a clean download is a cache no-op.
"""
import pytest

from pipeline.contracts import FootageRequest
from pipeline import footage as footage_stage


def _video(link, duration):
    return {"duration": duration, "video_files": [
        {"link": link, "width": 1080, "height": 1920, "file_type": "video/mp4"}]}


def test_failed_download_leaves_no_dest_and_no_sidecar(tmp_path):
    """A downloader that writes a partial file then raises must leave neither a
    `dest` .mp4 nor a `.frames` sidecar — so a later run can't serve the truncate."""
    def good_search(query, key):
        return {"videos": [_video("http://x/clip.mp4", 6)]}

    def failing_download(url, dest):
        dest.write_bytes(b"partial")          # a truncated body lands in the .part
        raise IOError("connection dropped mid-stream")

    req = FootageRequest(index=0, query="ocean waves", min_frames=0)
    with pytest.raises(IOError):
        footage_stage._fetch_one(
            req, "ocean waves", tmp_path,
            fps=30, key="K", search=good_search, downloader=failing_download,
        )

    assert list(tmp_path.glob("*.mp4")) == []        # no dest serving a truncate
    assert list(tmp_path.glob("*.frames")) == []     # no sidecar pointing at nothing
    assert list(tmp_path.glob("*.part")) == []       # the temp was cleaned up too
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_download.py::test_failed_download_leaves_no_dest_and_no_sidecar -v`
Expected: FAIL — current `_fetch_one` calls `downloader(url, dest)` directly, so `dest` (`footage_*.mp4`) is left containing `b"partial"` and the glob finds it.

- [ ] **Step 3: Write minimal implementation**

In `backend/pipeline/footage.py`, add `import os` next to the other stdlib imports (after `import hashlib`), then replace the `else:` body of `_fetch_one` (the download branch, lines ~117-124) so the download goes through a temp file:

```python
    if dest.exists():
        duration_frames = _read_sidecar(sidecar)  # may be None if unknown
    else:
        data = search(query, key)
        url, duration_frames = select_clip(data.get("videos", []), min_frames=req.min_frames, fps=fps)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_download.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full existing footage suite (regression — the injected fakes write to the temp path now)**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_relevance.py -v`
Expected: PASS (11 tests). The existing fakes `def fake_download(url, dest): dest.write_bytes(b"v")` write to whatever path they're given — now the `.part` temp — and `os.replace` moves it onto `dest`, so `clips[0].path` still ends `.mp4` and durations are unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/footage.py backend/tests/test_footage_download.py
git commit -m "$(cat <<'EOF'
fix(footage): atomic temp→rename download so a dropped stream can't cache a truncate

_fetch_one streamed straight into dest; a mid-stream drop left a partial file the
`if dest.exists()` cache check served as valid. Download into a sibling .part and
os.replace onto dest only on success (unlink the .part on any failure); write the
.frames sidecar only after the rename. Placed at the downloader-invocation level so
it stays downloader-agnostic and testable with the injected-downloader fakes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2: Clean download is a cache no-op (atomic-write regression guard)

**Files:**
- Test: `backend/tests/test_footage_download.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_footage_download.py`:

```python
def test_clean_download_then_cache_hit_does_not_redownload(tmp_path):
    """First call downloads (and writes dest + sidecar); the second call with the
    SAME query is a cache hit — the downloader is never invoked again."""
    calls = {"download": 0, "search": 0}

    def good_search(query, key):
        calls["search"] += 1
        return {"videos": [_video("http://x/clip.mp4", 6)]}

    def good_download(url, dest):
        calls["download"] += 1
        dest.write_bytes(b"full clip bytes")

    req = FootageRequest(index=0, query="ocean waves", min_frames=0)
    c1 = footage_stage._fetch_one(req, "ocean waves", tmp_path,
                                  fps=30, key="K", search=good_search, downloader=good_download)
    c2 = footage_stage._fetch_one(req, "ocean waves", tmp_path,
                                  fps=30, key="K", search=good_search, downloader=good_download)

    assert calls == {"download": 1, "search": 1}     # second call hit the cache
    assert c1.path == c2.path
    assert c1.duration_frames == c2.duration_frames == 180   # 6s * 30fps, from the sidecar
    assert len(list(tmp_path.glob("*.mp4"))) == 1    # exactly one cached clip
```

- [ ] **Step 2: Run test to verify it passes (this guards existing behavior under the new atomic path)**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_download.py::test_clean_download_then_cache_hit_does_not_redownload -v`
Expected: PASS. (The cache-hit branch already existed; this test pins that the atomic rewrite preserved it. If it fails, the rename/sidecar ordering in Task 1 is wrong.)

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_footage_download.py
git commit -m "$(cat <<'EOF'
test(footage): clean download then cache hit never re-downloads (atomic-write guard)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: Bounded 429/5xx backoff in `search_pexels` (honors Retry-After)

**Files:**
- Modify: `backend/pipeline/footage.py:81-89` (`search_pexels`), add `import time`
- Test: `backend/tests/test_footage_download.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_footage_download.py`:

```python
class _FakeResp:
    def __init__(self, status, *, json_body=None, headers=None):
        self.status_code = status
        self._json = json_body or {}
        self.headers = headers or {}
    def json(self):
        return self._json
    def raise_for_status(self):
        import requests
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")


def test_search_pexels_retries_on_429_then_succeeds_honoring_retry_after():
    slept = []
    responses = iter([
        _FakeResp(429, headers={"Retry-After": "5"}),       # rate-limited, told to wait 5s
        _FakeResp(200, json_body={"videos": [{"id": 1}]}),  # then OK
    ])

    def fake_get(url, **kw):
        return next(responses)

    out = footage_stage.search_pexels(
        "ocean waves", "K", _get=fake_get, _sleep=slept.append, max_retries=3,
    )

    assert out == {"videos": [{"id": 1}]}
    assert slept == [5.0]            # honored the Retry-After header, retried once


def test_search_pexels_exhausts_retries_then_raises():
    slept = []

    def always_429(url, **kw):
        return _FakeResp(429, headers={})        # no Retry-After → exponential backoff

    import requests
    with pytest.raises(requests.HTTPError):
        footage_stage.search_pexels(
            "ocean waves", "K", _get=always_429, _sleep=slept.append, max_retries=2,
        )
    assert slept == [1.0, 2.0]       # 2^0, 2^1 backoff between the 3 attempts, then raised
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_download.py -k search_pexels -v`
Expected: FAIL — `search_pexels` currently takes only `(query, key)` and has no `_get`/`_sleep`/`max_retries` params, so it raises `TypeError`.

- [ ] **Step 3: Write minimal implementation**

In `backend/pipeline/footage.py`, add `import time` near the stdlib imports, then replace `search_pexels`:

```python
def search_pexels(query: str, key: str, *, _get=None, _sleep=None, max_retries: int = 3) -> dict:
    """Search Pexels for portrait clips. Bounded retry with exponential backoff on
    429/5xx (honoring a Retry-After header on 429 when present), then raise — the
    caller (fetch_footage) broadens to the title on the raised error. The retry cap
    is small and fixed (Phase-3 cost discipline); _get/_sleep are injectable for tests."""
    _get = _get or requests.get
    _sleep = _sleep or time.sleep
    for attempt in range(max_retries + 1):
        r = _get(
            PEXELS_VIDEO_SEARCH,
            params={"query": query, "orientation": "portrait", "per_page": 15, "size": "medium"},
            headers={"Authorization": key},
            timeout=30,
        )
        retryable = r.status_code == 429 or 500 <= r.status_code < 600
        if retryable and attempt < max_retries:
            retry_after = r.headers.get("Retry-After")
            delay = float(retry_after) if (retry_after and retry_after.isdigit()) else float(2 ** attempt)
            _sleep(delay)
            continue
        r.raise_for_status()
        return r.json()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_download.py -k search_pexels -v`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full footage suites (regression)**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_relevance.py backend/tests/test_footage_download.py -v`
Expected: PASS (all). `fetch_footage` still injects its own `search` fakes, so the broaden-on-429-error path (already tested in `test_footage_relevance.py`) is unaffected; exhausted backoff raises `HTTPError`, which `attempt()` catches and broadens.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/footage.py backend/tests/test_footage_download.py
git commit -m "$(cat <<'EOF'
fix(footage): bounded 429/5xx backoff in search_pexels (honors Retry-After)

Small fixed retry cap with exponential backoff on 429/5xx, honoring a Retry-After
header on 429. On exhaustion it raises, and the existing broaden-on-error path in
fetch_footage takes over (fails closed). _get/_sleep injectable for tests.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## ITEM 1 — Collision hardening (deterministic frozen-rule pass)

Files in play:
- Create: `backend/pipeline/footage_query.py`
- Create: `backend/tests/test_footage_query.py`
- Modify: `backend/pipeline/recipe.py` (import + the query seam at line 176)
- Modify: `backend/main.py` (`_footage_requests`, harden the `broad_query` too)

### Task 4: The `harden()` lexicon layer

**Files:**
- Create: `backend/pipeline/footage_query.py`
- Test: `backend/tests/test_footage_query.py` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_footage_query.py`:

```python
"""Item 1 — deterministic footage-query hardening. Layer B proved prompt-only
steering can't predict Pexels collisions; this frozen lexicon remaps known
colliding keywords to a filmable replacement, and a conservative named-entity
guard degrades an UNKNOWN capitalized-proper-noun query to the title fallback.
Pure + deterministic — no provider calls. Seeded from the Layer-A map in
memory/phase4-footage-relevance.md.
"""
from pipeline.footage_query import harden, COLLISION_LEXICON


def test_lexicon_remaps_a_known_collision_whole_phrase():
    # "hand crank" → coffee grinder on Pexels; remap to the visible mechanism.
    assert harden("hand crank", title="Antique Clocks") == "antique brass gears turning"


def test_lexicon_remaps_when_the_phrase_is_contained_in_a_longer_query():
    # the colliding phrase buried in a longer keyword still triggers the remap.
    assert harden("old celestial globe closeup", title="Astronomy") == "ancient astronomical instrument"


def test_lexicon_is_case_and_whitespace_insensitive():
    assert harden("  Hand   Crank ", title="X") == "antique brass gears turning"


def test_clean_keyword_passes_through_unchanged():
    # a clean common-noun keyword must NOT be touched (no over-eager rewrite).
    assert harden("brass clockwork gears", title="Antique Clocks") == "brass clockwork gears"


def test_named_subjects_from_layer_a_are_all_seeded():
    # the full Layer-A / banked-bug map is present, not just one example.
    for key in ["hand crank", "celestial globe", "ocean evaporation steam",
                "wooden box", "antikythera mechanism", "challenger deep", "nobel medal"]:
        assert key in COLLISION_LEXICON, f"missing lexicon seed: {key!r}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_query.py -v`
Expected: FAIL — `pipeline.footage_query` does not exist (ImportError).

- [ ] **Step 3: Write minimal implementation**

Create `backend/pipeline/footage_query.py`:

```python
"""Deterministic footage-query hardening (Phase-4 Item 1).

Layer-B testing proved a prompt rule can't make the model predict which keywords
collide with a dominant unrelated Pexels meaning (memory/phase4-footage-relevance.md).
So this is the ruled next lever: a FROZEN lexicon remapping known colliding keywords
to a filmable replacement, plus a conservative named-entity guard that degrades an
UNKNOWN capitalized-proper-noun query to the title fallback rather than ship a
known-bad named search. Pure + deterministic — no provider calls. LLM query
re-derivation is the A.2 footage gate's job, not this.
"""
from __future__ import annotations

import re

# colliding phrase (normalized) -> filmable replacement. Seeded from the Layer-A map
# (confirmed eyes-on wins) + the banked Antikythera-render bugs. Auditable like CREDITS.
COLLISION_LEXICON: dict[str, str] = {
    "hand crank": "antique brass gears turning",        # → coffee grinder
    "celestial globe": "ancient astronomical instrument",  # → celestial body / exoplanet
    "ocean evaporation steam": "sea mist over waves",   # → geothermal vent
    "wooden box": "antique astronomical instrument",    # the Antikythera "drawer" miss
    "antikythera mechanism": "antique astronomical instrument",  # → typewriter/drawer
    "antikythera": "antique astronomical instrument",
    "challenger deep": "dark ocean abyss",              # → aquarium
    "nobel medal": "physics laboratory",
}

_STOPWORDS = {"the", "a", "an", "of", "and", "in", "on", "at", "to", "for", "with"}
_WORD = re.compile(r"[A-Za-z][A-Za-z'\-]*")


def _normalize(q: str) -> str:
    return re.sub(r"\s+", " ", q.strip().lower())


def _propers(text: str) -> set[str]:
    """Lowercased set of CAPITALIZED, length>=4, non-stopword tokens in `text`
    (original case). A conservative proper-noun signal: a lowercase token never
    qualifies, so a clean lowercase keyword cannot trip the guard."""
    out: set[str] = set()
    for tok in _WORD.findall(text):
        if len(tok) >= 4 and tok[0].isupper() and tok.lower() not in _STOPWORDS:
            out.add(tok.lower())
    return out


def harden(query: str, *, title: str) -> str:
    norm = _normalize(query)
    if not norm:
        return query
    # Layer A — frozen lexicon: exact phrase, then substring containment.
    if norm in COLLISION_LEXICON:
        return COLLISION_LEXICON[norm]
    for phrase, repl in COLLISION_LEXICON.items():
        if phrase in norm:
            return repl
    # Layer B — named-entity guard (biased to FALSE-NEGATIVE): fire only when a token
    # the model CAPITALIZED in the query is ALSO a capitalized proper noun in the
    # title (the named subject). Both signals required, so a clean lowercase keyword
    # is never degraded. Degrade to the title (the existing broaden fallback).
    if _propers(query) & _propers(title):
        return title
    return query
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_query.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/footage_query.py backend/tests/test_footage_query.py
git commit -m "$(cat <<'EOF'
feat(footage): deterministic collision-lexicon hardening (Item 1, Layer A)

Frozen lexicon remaps known colliding keywords (hand crank→coffee grinder, etc.)
to a filmable replacement, seeded from the Layer-A eyes-on map. Pure + deterministic.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5: The named-entity guard + idempotence (Layer B)

**Files:**
- Test: `backend/tests/test_footage_query.py` (append)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_footage_query.py`:

```python
def test_guard_degrades_unknown_capitalized_proper_noun_to_title():
    # "Voynich" is capitalized in BOTH query and title (the named subject) and is
    # NOT in the lexicon → degrade to the title rather than ship a named search.
    assert harden("Voynich script", title="The Voynich Manuscript") == "The Voynich Manuscript"


def test_guard_does_not_fire_on_lowercase_keyword_false_negative_bias():
    # the SAME query lowercased carries no capitalization signal → passes through
    # (an accepted false-negative; degrading a good clean keyword is the worse failure).
    assert harden("voynich script", title="The Voynich Manuscript") == "voynich script"


def test_guard_does_not_fire_when_no_title_overlap():
    # a capitalized proper noun with NO match in the title is not the subject → leave it.
    assert harden("Sahara dunes", title="Deep Ocean Trenches") == "Sahara dunes"


def test_clean_lowercase_keyword_with_titlecased_common_title_is_untouched():
    # title-cased COMMON nouns in the title must not degrade a lowercase keyword.
    assert harden("ocean trench", title="Deep Ocean") == "ocean trench"


def test_harden_is_idempotent():
    # hardening an already-hardened query is stable (no replacement re-triggers another).
    t = "The Antikythera Mechanism"
    once = harden("antikythera mechanism", title=t)
    assert harden(once, title=t) == once
    t2 = "The Voynich Manuscript"
    once2 = harden("Voynich script", title=t2)
    assert harden(once2, title=t2) == once2
```

- [ ] **Step 2: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_query.py -v`
Expected: PASS. The guard and idempotence are already implemented in Task 4's `harden()`; this task pins the false-negative bias and idempotence with explicit tests. If `test_clean_lowercase_keyword_with_titlecased_common_title_is_untouched` fails, the guard is keying on title capitalization alone instead of requiring query capitalization too — revisit `_propers(query) & _propers(title)`.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_footage_query.py
git commit -m "$(cat <<'EOF'
test(footage): named-entity guard false-negative bias + idempotence (Item 1, Layer B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6: Wire `harden()` into the query seam (recipe + broad_query)

**Files:**
- Modify: `backend/pipeline/recipe.py:26` (import) and `:176` (the query)
- Modify: `backend/main.py:29` (import) and `_footage_requests` (`broad_query`)
- Test: `backend/tests/test_footage_relevance.py` (append a wiring test)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_footage_relevance.py`:

```python
# ── Item 1: harden() is wired into the query seam (recipe + broad_query) ──

def test_recipe_hardens_a_colliding_keyword_into_a_filmable_query():
    from pipeline.recipe import plan
    script = BeatsScript(title="Antique Clocks", beats=[
        Beat(text="hook"),
        Beat(text="a hand crank drives the gears", keywords="hand crank"),
        Beat(text="outro"),
    ])
    p = plan(script, theme=Theme())
    assert p.scenes[1].query == "antique brass gears turning"   # collision remapped, not "hand crank"


def test_footage_requests_harden_the_broad_query_too():
    # broadening to a COLLIDING title would re-introduce the dominant-meaning miss the
    # specific query dodged — so the broad_query is hardened as well.
    from main import _footage_requests
    from pipeline.recipe import plan
    p = plan(BeatsScript(title="The Antikythera Mechanism",
                         beats=[Beat(text="h"), Beat(text="scene"), Beat(text="o")]),
             theme=Theme())
    offsets = [LineOffset(0, "h", 0.0, 1.0), LineOffset(1, "scene", 1.0, 3.0), LineOffset(2, "o", 3.0, 4.0)]
    reqs = _footage_requests(p, offsets, {}, 30)
    assert reqs[0].broad_query == "antique astronomical instrument"   # hardened, not the colliding title
```

- [ ] **Step 2: Run test to verify it fails**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_relevance.py -k "hardens or harden_the_broad" -v`
Expected: FAIL — `recipe.plan` returns the raw `"hand crank"`, and `_footage_requests` sets `broad_query` to the raw colliding title.

- [ ] **Step 3: Write minimal implementation**

In `backend/pipeline/recipe.py`, add to the imports (after line 26, `from pipeline.content import Beat, BeatsScript`):

```python
from pipeline.footage_query import harden
```

Then change the footage-scene line (`recipe.py:176`) from:

```python
                    PlannedScene(role, catalog["scene"], {}, needs_footage=True, query=(beat.keywords or script.title))
```

to:

```python
                    PlannedScene(role, catalog["scene"], {}, needs_footage=True,
                                 query=harden(beat.keywords or script.title, title=script.title))
```

In `backend/main.py`, add to the imports (after line 29, `from pipeline.contracts import FootageRequest`):

```python
from pipeline.footage_query import harden
```

Then in `_footage_requests` change the `broad_query=plan.title` to harden it:

```python
        FootageRequest(index=i, query=ps.query, min_frames=(durations[i] + headroom) // 2,
                       broad_query=harden(plan.title, title=plan.title))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `backend/.venv/bin/python -m pytest backend/tests/test_footage_relevance.py -v`
Expected: PASS (all — including the existing `test_footage_requests_carry_title_as_broad_query`, since `harden("Coral Reefs", title="Coral Reefs")` returns `"Coral Reefs"` unchanged).

- [ ] **Step 5: Run the full backend suite (regression)**

Run: `backend/.venv/bin/python -m pytest backend/tests -q`
Expected: PASS (no regressions across the pipeline).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/recipe.py backend/main.py backend/tests/test_footage_relevance.py
git commit -m "$(cat <<'EOF'
feat(footage): wire harden() into the recipe query seam + the broad_query fallback

The recipe's footage query (beat.keywords or title) and the broaden-on-empty title
both pass through harden(), so a colliding keyword is remapped before search AND a
broaden to a colliding title can't re-introduce the dodged collision.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 7: Item 1 render gate (eyes-on, blocks the PR)

**Files:**
- Uses: `backend/pipeline/footage_diagnostic.py` (existing) and/or a full TTS-timed render.

- [ ] **Step 1: Produce the relevance evidence for the Antikythera case**

Run the footage diagnostic on the collision topic to show the hardened query and its Pexels pick (Pexels key required in `.env`):

```bash
backend/.venv/bin/python backend/pipeline/footage_diagnostic.py --topic "The Antikythera Mechanism" --thumbs /tmp/footage-diag/antik
```

If a composed video is preferred for the ruling, run the full pipeline + render:

```bash
backend/.venv/bin/python backend/main.py --topic "The Antikythera Mechanism"
cd remotion && npm run render
```

- [ ] **Step 2: Surface the artifacts for upload**

The reviewer can only see files via `/mnt/user-data/uploads`. After producing them, tell the reviewer explicitly which files to upload, e.g.:
> "Upload `/tmp/footage-diag/antik/` (the ranked thumbnails) and `remotion/out/video.mp4` to `/mnt/user-data/uploads` so you can rule on whether the Antikythera footage now reads as relevant."

- [ ] **Step 3: PAUSE for the reviewer's ruling.** Do not proceed to the PR. If the reviewer flags a residual collision, add the offending phrase to `COLLISION_LEXICON` (a one-line, tested extension) and re-render.

---

## ITEM 2 — Enumeration bare-dot fix (monogram hero + circle list)

Files in play:
- Modify: `templates/enumeration/media.ts` (expand `ICON_MAP`; add `monogram()`)
- Modify: `templates/enumeration/Component.tsx:104` (hero floor) and `:162-163` (list floor)
- Test: `remotion/src/enumeration-media.test.ts`

### Task 8: Expand `ICON_MAP` coverage (planets + common terms)

**Files:**
- Modify: `templates/enumeration/media.ts:36-43` (`ICON_MAP`)
- Test: `remotion/src/enumeration-media.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `remotion/src/enumeration-media.test.ts` (inside the existing top-level, after the `resolveMedia cascade` describe block — keep imports as they are):

```typescript
describe('ICON_MAP planet/common-term coverage (no bare dot for the obvious set)', () => {
  it('resolves the inner/outer planets to an icon, not a mark', () => {
    for (const p of ['Mercury', 'Venus', 'Jupiter', 'Saturn', 'Neptune', 'Uranus']) {
      expect(resolveMedia(p).kind).toBe('icon');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd remotion && npx vitest run src/enumeration-media.test.ts -t "planet"`
Expected: FAIL — `mercury`/`venus`/`jupiter`/etc. are not in `ICON_MAP`, so `resolveMedia` returns `{kind:'mark'}`.

- [ ] **Step 3: Write minimal implementation**

In `templates/enumeration/media.ts`, extend `ICON_MAP` (lines 36-43) by adding the planet + a few common terms (reuse existing `LucideName` values — `circle`, `orbit`, `globe`, `flame`, `droplet`, `waves` are all already in the `LucideName` union). Append these entries inside the existing object literal:

```typescript
  // planets — no curated per-planet image yet (deferred); give every named planet a
  // real icon so it never falls to the floor. Generic 'circle' for the gas/ice giants.
  mercury: 'circle', venus: 'circle', jupiter: 'circle', saturn: 'orbit',
  neptune: 'circle', uranus: 'circle', pluto: 'circle', sun: 'sun',
```

Note: `sun`, `moon`, `planet`, `earth`, `mars` already exist in `ICON_MAP` — do NOT duplicate keys (the `sun` above is illustrative; if a key already exists, skip it). The net new keys are: `mercury, venus, jupiter, saturn, neptune, uranus, pluto`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd remotion && npx vitest run src/enumeration-media.test.ts`
Expected: PASS (existing 7 + the new planet test; the `imageManifest ⊆ iconMap` invariant still holds — no new image keys were added).

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/media.ts remotion/src/enumeration-media.test.ts
git commit -m "$(cat <<'EOF'
feat(enumeration): ICON_MAP coverage for named planets (no floor for the obvious set)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 9: The `monogram()` grapheme rule

**Files:**
- Modify: `templates/enumeration/media.ts` (add `monogram()` export)
- Test: `remotion/src/enumeration-media.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `remotion/src/enumeration-media.test.ts`, and add `monogram` to the import at the top of the file (change `import {resolveMedia, iconNameFor, IMAGE_MANIFEST, ICON_MAP}` to also include `monogram`):

```typescript
import {monogram} from '../../templates/enumeration/media';

describe('monogram (the designed floor grapheme rule — never a blank badge)', () => {
  it('uppercases the first letter of a normal label', () => {
    expect(monogram('Mercury')).toBe('M');
    expect(monogram('venus')).toBe('V');
  });
  it('skips a leading symbol/space to the first letter-or-digit', () => {
    expect(monogram('  #hashtag')).toBe('H');
    expect(monogram('  3-body problem')).toBe('3');   // a leading digit is representable
  });
  it('uses the first representable char of a non-Latin script', () => {
    expect(monogram('日本')).toBe('日');               // CJK: no case, returned as-is
  });
  it('returns null when there is no representable character (→ circle fallback)', () => {
    expect(monogram('')).toBeNull();
    expect(monogram('   ')).toBeNull();
    expect(monogram('!!!')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd remotion && npx vitest run src/enumeration-media.test.ts -t "monogram"`
Expected: FAIL — `monogram` is not exported from `media.ts` (import error / undefined).

- [ ] **Step 3: Write minimal implementation**

In `templates/enumeration/media.ts`, add (e.g. after `iconNameFor`):

```typescript
/** The designed FLOOR grapheme for an item with no image and no icon: the first
 *  letter-or-digit, uppercased, iterating by code point so a leading symbol/space is
 *  skipped and non-Latin scripts return their first char. Returns null when no
 *  character is representable (empty/whitespace/punctuation-only) → the caller falls
 *  back to a clean glyph. Pure; never throws, never yields a blank badge. */
export function monogram(label: string): string | null {
  for (const ch of label.trim()) {            // for..of iterates Unicode code points
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLocaleUpperCase();
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd remotion && npx vitest run src/enumeration-media.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/media.ts remotion/src/enumeration-media.test.ts
git commit -m "$(cat <<'EOF'
feat(enumeration): monogram() grapheme rule for the designed floor (never blank)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 10: Render the floor — monogram hero + circle list (replace the bare dots)

**Files:**
- Modify: `templates/enumeration/Component.tsx:103-105` (hero `mark`) and `:162-163` (list `mark`)
- Test: covered by the vitest above (pure) + the render gate (Task 11). No new unit test — `Component.tsx` is JSX with no pure seam beyond `monogram()`/`resolveMedia()` already tested.

- [ ] **Step 1: Update the import**

In `templates/enumeration/Component.tsx:6`, add `monogram` to the media import:

```typescript
import {resolveMedia, iconNameFor, monogram} from './media';
```

- [ ] **Step 2: Replace the HERO bare-dot (lines 103-105)**

Replace the `mark` branch of the hero media (the final `: (` ... `)` of the ternary, currently the muted `●` div) with a monogram badge that falls back to a `circle` glyph when `monogram()` is null:

```tsx
                ) : monogram(label) ? (
                  <div
                    style={{
                      width: HERO_IMG,
                      height: HERO_IMG,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 40,
                      boxShadow: ring,
                      background: '#000',
                      fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
                      fontWeight: 800,
                      fontSize: HERO_ICON,
                      color: theme.palette.accent,
                    }}
                  >
                    {monogram(label)}
                  </div>
                ) : (
                  <div style={{width: HERO_IMG, height: HERO_IMG, display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                    <LucideGlyph name="circle" size={HERO_ICON} color={theme.palette.foreground} />
                  </div>
                )}
```

- [ ] **Step 3: Replace the LIST bare-dot (lines 162-163)**

Replace the list-row `mark` branch (the `media.kind === 'mark' ? (<span>●</span>) : (...)` ternary) so a `mark` row renders a clean `circle` glyph instead of the `●`:

```tsx
                {media.kind === 'mark' ? (
                  <LucideGlyph name="circle" size={Math.round(sz.iconSize * 0.82)} color={iconColor} />
                ) : (
                  // image item -> its icon (iconNameFor); icon item -> that name.
                  <LucideGlyph
                    name={media.kind === 'icon' ? media.name : iconNameFor(label) ?? 'circle'}
                    size={Math.round(sz.iconSize * 0.82)}
                    color={iconColor}
                  />
                )}
```

- [ ] **Step 4: Verify the component compiles + the suite is green**

Run: `cd remotion && npx tsc --noEmit && npx vitest run src/enumeration-media.test.ts src/enumeration-herostate.test.ts`
Expected: PASS (typecheck clean; vitest green). There should now be NO `●` literal left in `Component.tsx` — verify:

Run: `grep -n "●" templates/enumeration/Component.tsx`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add templates/enumeration/Component.tsx
git commit -m "$(cat <<'EOF'
feat(enumeration): designed floor — monogram hero + circle list, never a bare dot

The hero mark renders a first-letter monogram badge (circle glyph when no grapheme
is representable); the list row renders a clean circle glyph. Removes the unstyled ●
that produced the video__7 bare-dot defect for unmanifested items.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 11: Item 2 render gate (eyes-on, blocks the PR)

**Files:**
- Uses: `backend/scripts/enumeration_gate.py` (existing harness).

- [ ] **Step 1: Render an enumeration with genuinely unmanifested items**

The layout has motion, so produce a short clip or a dense entrance strip (not a still). Use the existing gate harness with an item set that hits the floor (e.g. arbitrary non-curated nouns so the monogram fires):

```bash
backend/.venv/bin/python backend/scripts/enumeration_gate.py
```

If the harness fixes its item set to the curated 5, add/clone a variant whose items are deliberately unmanifested (e.g. `["Mercury","Venus","Jupiter","Zorblax","Quux"]`) so the hero shows planet icons (Task 8) and the monogram floor (Zorblax→Z, Quux→Q). Produce the MP4 + the dense frame strip the harness already emits.

- [ ] **Step 2: Surface the artifacts for upload**

Tell the reviewer explicitly which files to upload to `/mnt/user-data/uploads`, e.g.:
> "Upload the gate MP4 and the entrance frame strip from `enumeration-gate-frames/` to `/mnt/user-data/uploads` — this is where you rule whether the monogram-hero floor reads premium or should fall back to the clean glyph."

- [ ] **Step 3: PAUSE for the reviewer's ruling** on whether the monogram reads premium (vs falling back to the clean glyph). Do not proceed to the PR.

---

## FINAL: PR → development (only after both render rulings)

- [ ] **Step 1: Confirm both render gates ruled GO** (Task 7 + Task 11) by the reviewer.

- [ ] **Step 2: Full green sweep**

Run: `backend/.venv/bin/python -m pytest backend/tests -q`
Run: `cd remotion && npx tsc --noEmit && npx vitest run`
Run: `cd preview && npx tsc --noEmit` (the lucide alias path resolves)
Expected: all PASS.

- [ ] **Step 3: Confirm topology**

Run: `git log enumeration-visual-tier2 ^development --oneline` (linear, no merge commits) and `git log enumeration-visual-tier2 ^development --merges --oneline | wc -l` → `0`.

- [ ] **Step 4: Open the PR — ONLY on the reviewer's explicit go.** Branch off `development`, PR into `development`, never `master`. (Per the standing rule, development→master is the operator's job alone.)

---

## Self-Review (completed during plan authoring)

- **Spec coverage:** Item 1 (lexicon Task 4 + guard/idempotence Task 5 + wiring Task 6 + render gate Task 7), Item 2 (coverage Task 8 + monogram Task 9 + render Task 10 + render gate Task 11), Item 3 (atomic write Task 1 + cache-noop Task 2 + 429 backoff Task 3). All design §2/§3/§4 requirements map to a task. Refinements folded in: named-entity false-negative bias (Task 5), Layer-A seed completeness (Task 4 `test_named_subjects_from_layer_a_are_all_seeded`), idempotence (Task 5), grapheme rule (Task 9), downloader-level atomic write (Task 1), Retry-After (Task 3).
- **Placeholder scan:** one illustrative brittle line in Task 2 Step 1 is explicitly flagged with its replacement; no TBDs.
- **Type/name consistency:** `harden(query, *, title)` and `COLLISION_LEXICON` used identically across Tasks 4-6; `monogram(label)` across Tasks 9-10; `_fetch_one`/`search_pexels` signatures consistent across Tasks 1-3.
- **Invariants:** no `spec.json` contract change in any task; `harden` only rewrites the query string (never span/timing); the atomic write fails closed; the backoff is bounded.
