# Footage topic-anchoring — design

**Date:** 2026-06-14
**Branch:** `footage-topic-anchor` (off `development`)
**Status:** approved (Approach 1)

## Problem

Each scene's stock-footage query is built independently from that beat's 2–4 word
`keywords`, with no knowledge of the overall video subject. Pexels matches those
words **literally**, so a drifted keyword returns an off-topic clip: a beat about
octopus camouflage with keywords `color changing skin` returns a chameleon or LED
lights, because the query never said "octopus".

The clean signal — the user's raw topic (`sessions.topic`, a clean noun phrase like
"octopuses" / "the Antikythera mechanism") — is preserved in `EngineContext.topic`
but **thrown away before the query is built**. The only video-level string that
reaches the query seam is the LLM-generated clickbait `title`, used reactively as a
whiff fallback. The per-beat keyword prompt (`KEYWORD_RULE_SEGMENT`) is already
sophisticated and still drifts; prompt tuning has hit diminishing returns. The
missing lever is **getting the clean subject into the query itself.**

This is failure mode **A** (keywords lose the topic), not B (good query, bad pick).
A reranker over Pexels candidates (the parked A.2c idea) addresses B and is the wrong
tool here.

## Approach

Deterministically prepend a sanitized **subject anchor**, derived from the user's raw
topic, to each per-scene footage query — composed at the point where the
`FootageRequest` is built and the topic is already in scope. Pure, no new LLM call,
fully unit-testable, composes with the existing `harden()` lexicon and the
`fetch_footage` whiff-broaden ladder.

### Query / fallback semantics

```
anchor      = topic_anchor(topic)          # clean subject, hardened: "octopuses"
query       = anchor_query(ps.query, anchor)   # "octopuses color changing skin"
broad_query = anchor or ps.query               # whiff → broaden to the subject
```

Two-rung ladder: **anchored query → subject anchor**. On a whiff the query degrades
to the clean subject ("octopuses"), which is on-topic by construction — strictly
better than today's clickbait-title broaden.

### Drift-only anchoring (no-op when already on-subject)

`anchor_query` prepends the anchor **only when the keyword shares no content token
with the anchor**. A keyword that already names the subject ("coral reef" for topic
"Coral Reefs") is left byte-identical; the anchor fires only on true drift. This
keeps the common good case unchanged and minimizes regression surface.

### Proper-noun / collision safety

`topic_anchor` routes the subject through the existing `harden()` (Layer-A collision
lexicon + Layer-B named-entity guard), so a rare proper-noun topic degrades to a
filmable category ("the Antikythera mechanism" → "antique astronomical instrument")
instead of a zero-result named search. If a degenerate/empty topic yields no anchor,
`broad_query` falls back to `ps.query` and `query` is left unchanged — i.e. exactly
today's behavior.

### Subject extraction

`topic_anchor` strips a leading list-framing from the raw topic before hardening:
- count prefix: `top 5 ` / `3 ` (mirrors `script._COUNT_PREFIX`)
- list frame: `facts about ` / `ways to ` / `reasons ` / `types of ` …

so "3 facts about octopuses" → "octopuses" and "top 5 ways to save money" → "save
money". A bare topic ("octopuses", "deep sea creatures") passes through unchanged.

## Code touch points

- **`backend/pipeline/footage_query.py`** — add pure helpers `topic_anchor(topic)`,
  `anchor_query(query, anchor)`, and a `_content_tokens` helper. No change to
  `harden`.
- **`backend/session/executors.py`** — `_footage_requests` (the live builder):
  compute `anchor = topic_anchor(ctx.topic)` once; set `query=anchor_query(ps.query,
  anchor)` and `broad_query=anchor or ps.query`.
- **`backend/pipeline/recipe.py`** and `PlannedScene` — **unchanged**.
- **Dead code:** `main._footage_requests` is documented dead for the run path
  (run() builds requests via `executors._footage_requests`; only 3 tests in
  `test_footage_relevance.py` call it). Removed in the dead-code sweep, its tests
  migrated to the live builder.

## Testing

- Unit tests for `topic_anchor` (count/list-frame strip, proper-noun→filmable,
  empty topic) and `anchor_query` (drift prepends, on-subject no-op, empty anchor
  no-op).
- `executors._footage_requests` test extended: drift scene gets anchored query;
  `broad_query` carries the subject anchor. Existing min_frames/needs_footage test
  stays green unchanged.
- Full backend suite green.

## Verification gate

Per project rhythm, an operator **eyes-on on real pixels** is required before merge:
generate a known-drift topic (e.g. "octopuses") and confirm scene clips are on-topic
(not generic/random) on the rendered frames. Agent does not self-certify the visual
result.

## Out of scope

- Semantic/LLM reranker over Pexels candidates (parked A.2c — different failure mode).
- Keyword-prompt changes (Approach 3 — already sophisticated, diminishing returns).
- Hero-pool query anchoring (hero queries exist only on `studio-v3`, not `development`).
