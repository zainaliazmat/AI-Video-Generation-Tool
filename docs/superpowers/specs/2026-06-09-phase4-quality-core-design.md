# Phase-4 Quality Core (HITL Plan #1 / A.0 prerequisites) — Design

**Date:** 2026-06-09
**Branch:** `enumeration-visual-tier2` (continue; one PR → `development` at the end)
**Status:** Approved (reviewer), refinements folded in. Implementation plan follows.

This is the first plannable slice of the Human-in-the-Loop (HITL) spec
(`faceless-video-HITL-spec`). The HITL spec's §7 makes A.0 a hard prerequisite:
*"A footage gate over a still-broken core just surfaces bad options to the human."*
So before any session spine or gate UI, we finish the paused Phase-4 quality core —
the two `video__7_` defects plus the footage-download hardening.

Everything else in the HITL spec (session spine, footage/script/voice/assemble gates,
DeepSeek chat, voice picker, imagery-behind-cards, any contract change) is **out of
scope for this plan** and gets its own spec → plan → build cycle later.

---

## 0. Grounding — how the spec maps to the real code (corrections)

Four parallel explorations mapped the HITL spec onto the live code. The spec is ~80%
accurate; the corrections that matter for *this* plan:

- **The pipeline is stateless** (`backend/main.py:run(topic)` → `spec.json` + a
  `sources.json` sidecar). No session/project document, no resumability. (Irrelevant to
  Plan #1, which touches only the autopilot core — noted so later plans don't assume it.)
- **`spec.json` is genuinely the sole render contract**; `validate.py` already gates
  specs (slot/kind + JSON-Schema props). Plan #1 makes **no contract changes** — no
  schema mirror, no new spec.json fields.
- **The invariants hold and are untouched by this plan:** 1 beat = 1 narration span =
  1 scene; the gap-filling contiguity (`Σdᵢ = durationInFrames`); footage never feeds
  span/timing (short clip ⇒ loop, never trim).
- **The collision prompt rule already exists and is frozen** — `script.py` clause (d),
  committed `19afb90` (verified in tier2 history; live at `script.py:59-60`), carries the
  "anonymous category, NEVER a named landmark" amendment. Layer-B testing proved
  prompt-only steering has a **structural ceiling** (the model can't predict Pexels
  collisions and emits the colliding term whenever the narration names it). The Phase-4
  memory explicitly nominated a *deterministic post-gen collision lexicon* as the next
  lever — that is exactly Item 1.

### Branch topology (confirmed, not the stale "merge debt")

- `phase-4-footage-relevance` is **fully merged into `development`** (0 stranded commits);
  K-floor + relevance-first + diagnostic already live in `development` and tier2.
- `development` is a **clean ancestor of `enumeration-visual-tier2`** — tier2 =
  development + 12 commits, **0 merge commits** (confirmed:
  `git log enumeration-visual-tier2 ^development --oneline`).
- Decision: continue on tier2, commit the in-flight tree, build the three items on top,
  one PR → `development`. No untangling. Matches the standing rule (branch off
  `development`, PR into `development`, never touch `master`).

---

## 1. Scope — three items, nothing else

1. **Collision hardening** (fixes `video__7_` defect a: typewriter-for-Antikythera).
2. **Enumeration bare-dot fix** (fixes defect b: Mercury/Venus/Jupiter → bare `●`).
3. **Footage download hardening** (atomic write + bounded 429/5xx backoff).

All three are TDD, sub-gated. Build order: **Item 3 (logic-only) → Item 1 (logic +
render) → Item 2 (logic + render).** The two visual items get an eyes-on render gate
before the PR.

---

## 2. Item 1 — Collision hardening (deterministic frozen-rule pass)

**Why deterministic, not LLM:** Layer-B proved prompt steering can't generalize; the
memory ruled a deterministic lexicon the right next lever. LLM query re-derivation stays
**deferred to the A.2 footage gate** (on-rejection re-query), per the locked decision.

### 2.1 Mechanism

A new pure module `backend/pipeline/footage_query.py` exposing:

```
harden(query: str, *, title: str) -> str
```

Applied at the single query-derivation seam in `recipe.py:175`
(`query=(beat.keywords or script.title)`), so it covers **both** the `scene` path and
the verify-demoted-stat path (both feed `beat.keywords or title`). Pure + deterministic →
fully unit-tested, no provider calls, honors cost bounds.

Two layers:

**Layer 2.1.a — Frozen collision lexicon.** A curated, documented map
`colliding phrase → filmable replacement`, normalized (lowercased, whitespace-folded)
substring/whole-phrase match. Auditable like `CREDITS.json`. Seeded from the **full
Layer-A map** in `memory/phase4-footage-relevance.md` (the confirmed wins), not a couple
of examples:

| Colliding query (class) | Dominant wrong meaning | Filmable replacement |
|---|---|---|
| `hand crank` (dominant-meaning compound) | coffee grinder | `antique brass gears turning` |
| `celestial globe` (decomposing compound) | celestial body / exoplanet | `ancient astronomical instrument` |
| `ocean evaporation steam` (abstract process) | geothermal vent | `sea mist over waves` |
| `wooden box` / box-of-paper (the drawer/box miss) | random boxes | `antique astronomical instrument`* |
| `antikythera mechanism` (named niche object) | typewriter / drawer | `antique astronomical instrument` |
| `challenger deep` (named place) | aquarium | `dark ocean abyss` |
| `nobel medal` (named branded object) | (graceful lab fallback) | `physics laboratory` |

  \* the Antikythera "the mechanism" beat — stock cannot supply the real artifact (that's
  the deferred archival-imagery line); the best stock can do is the anonymous category.
  The exact lexicon entries are finalized in the implementation plan against the memory
  map; the table above is the seed set.

**Layer 2.1.b — Named-entity guard (deterministic proper-noun detection, no LLM).**
For *unknown* named entities not in the lexicon, detect a proper noun and **degrade to
the broad/title query** rather than ship a known-bad named search.

- **Detection, biased toward false-negatives (load-bearing):** missing a named entity is
  no regression (the lexicon + prompt already do most of the work), but **silently
  degrading a good clean keyword to the title flattens relevance and is the worse
  failure.** So the guard fires *only on a high-confidence proper-noun signal*:
  - operate on the **original-case** keyword string (before lowercasing);
  - a token is a proper-noun signal iff it is **Capitalized, length ≥ 4, not in a small
    stoplist** (e.g. `The/A/An` and other common sentence-initial words), **and** it also
    appears as a Capitalized non-stopword token in the **video title** (the named subject
    the script is about — a strong, precise signal);
  - if keywords arrive all-lowercase (no capitalization signal), the guard **does not
    fire** (accepted false-negative — the lexicon still catches known cases).
- **Action when it fires:** degrade to `broad_query`/title (the existing broaden path).
  Known named entities live in the lexicon (mapped to a safe category) so they never
  reach the guard; the guard is the backstop only for *unknown* proper nouns, where
  title-fallback is the existing behavior anyway → **no regression, occasional save.**
  (Caveat acknowledged: degrading to a title that itself contains the named entity can
  re-collide — but that is the pre-existing broaden behavior, not new.)

### 2.2 Properties / tests (code-logic gate)

- Each lexicon entry rewrites to its filmable replacement (table-driven).
- A clean common-noun keyword passes through **unchanged** (no over-eager degradation).
- A proper-noun-dominated unknown query (with title overlap) degrades to title; the same
  query without a capitalization signal passes through (false-negative bias proven).
- **Idempotence:** `harden(harden(q, title=t), title=t) == harden(q, title=t)` — an
  already-hardened query is stable (no replacement re-triggers another).

### 2.3 Render gate (eyes-on, before PR)

A TTS-timed render of the Antikythera case showing the hardened query fetches **relevant**
footage (the relevance fix is only truly confirmed on pixels — standing reviewer rule).

---

## 3. Item 2 — Enumeration bare-dot fix

**Invariant change:** *no enumeration item ever renders a bare `●`.* The two render
sites are `templates/enumeration/Component.tsx:104` (hero) and `:163` (list row). The
list-row *icon* path already floors at `?? 'circle'`; the bare-dot only appears for the
`mark` kind.

### 3.1 Floor design (decided)

- **Hero zone:** a **first-letter monogram** badge (Mercury → `M`, Venus → `V`) —
  distinct per item, informative, never blank.
- **List rows:** a clean **`circle`** lucide glyph (matches the row's existing `'circle'`
  fallback; small rows don't need monograms).

### 3.2 Three layers

1. **Coverage boost** — expand `ICON_MAP` in `media.ts` with the obvious astronomy /
   general terms (mercury, venus, jupiter, saturn, …) so common items get a real icon
   before any floor.
2. **Total floor** — `resolveMedia` / the component no longer emit an unstyled `●`. The
   `mark` kind renders as the monogram (hero) / `circle` glyph (list).
3. **Planet imagery: DEFERRED** — no per-planet image curation in this plan. The glyph
   floor already guarantees no bare dot; curated PD planet images are a later optional
   quality boost (with `CREDITS.json` provenance).

### 3.3 Monogram grapheme rule (build-time correctness, not a new gate)

The monogram needs a real grapheme rule, not naive `label[0]`:

- Take the **first letter-or-digit** of the label, uppercased.
- Leading digit/symbol/punctuation → skip to the first representable letter-or-digit.
- Non-ASCII / non-Latin script → use the first representable character (uppercased where
  the script has case); the component must render it, not assume ASCII width.
- Empty / whitespace-only label, or **no representable character** → fall back to the
  clean `circle` glyph.
- **Never throw, never render a blank badge.** (Pure function → unit-tested across these
  cases.)

### 3.4 Tests (vitest)

- Updated invariant: an unknown label resolves to the **designed glyph floor**, never a
  bare `●`/`mark` rendered as an unstyled dot.
- Keep `imageManifest ⊆ iconMap`.
- Grapheme rule across the §3.3 cases (digit-leading, symbol-leading, non-Latin, empty).

### 3.5 Render gate (eyes-on, before PR)

The layout has motion, so a **short clip or a dense entrance strip** (not a still) of an
enumeration with **genuinely unmanifested items**, showing the monogram hero floor + the
list rows. This is where the reviewer rules whether the monogram reads premium or should
fall back to the clean glyph. Produced via the existing `enumeration_gate.py` harness.

---

## 4. Item 3 — Footage download hardening (atomic write + 429/5xx backoff)

### 4.1 Atomic write (corrupt-cache landmine)

Today `footage.py:_download` streams straight into `dest`; a mid-stream drop leaves a
truncated file that the `if dest.exists()` cache check (`:115`) later serves as valid.

Fix, placed at the **`_fetch_one` / downloader-invocation level** (not buried inside
`_download`), so it stays downloader-agnostic and testable with the existing injected
`downloader` pattern:

- pass a **temp path** (`dest` + `.part`) to the downloader;
- on success, `os.replace(temp, dest)` (atomic rename within the same dir);
- on **any** failure, `unlink` the temp and propagate (so broaden-on-error still works);
- write the `.frames` sidecar **only after** the rename — it never points at a partial
  file.

### 4.2 429 / 5xx backoff

`search_pexels` gets **bounded** retry with exponential backoff on HTTP 429 (and 5xx)
before the existing broaden-on-error path takes over:

- **Honor a `Retry-After` header** on 429 if Pexels sends one; otherwise exponential
  backoff;
- **small, fixed retry cap** (honors the Phase-3 cost discipline — not unbounded);
- on exhaustion, fall through to the existing broaden-to-title path (fails closed).

### 4.3 Tests (code-logic gate, no render)

- An interrupted download leaves **no `dest`** and **no stale sidecar**; a retry produces
  a clean file.
- A re-run after a clean download is a **cache no-op**.
- 429 → retry → success; 429 exhausted → broaden; `Retry-After` honored.

---

## 5. Invariants (must not break)

- `spec.json` stays render-only; **no contract changes** in this plan.
- 1 beat = 1 span = 1 scene; the audio-sync math is untouched; footage never feeds
  span/timing.
- **Everything fails closed:** the named-entity guard degrades to title rather than ship
  a known-bad named search; the atomic write never serves a partial file; the 429 backoff
  is bounded.
- **TDD throughout** — test first for every item.

---

## 6. Render gates (eyes-on, before the PR)

The reviewer rules on pixels. Render artifacts are produced in the workspace, then the
**specific files are surfaced for upload to `/mnt/user-data/uploads`** (they do not reach
the reviewer from the workspace — only via that upload).

- **Item 1:** Antikythera case → relevant footage.
- **Item 2:** enumeration with unmanifested items → monogram-hero floor + list rows, as a
  short clip / dense entrance strip.

The PR → `development` waits for the reviewer's explicit go **after** both render rulings.

---

## 7. Out of scope (explicit)

Session spine, all HITL gates, DeepSeek chat / tool-use, the voice picker,
imagery-behind-cards, per-planet image curation, and any contract change. Plan #1 is only
the three items above.

---

## 8. In-flight tree (committed first, ahead of the three items)

The working tree already carried Phase-4 / Tier-2 continuation work, verified green
(11 backend + 18 vitest) before commit:

- `footage.py` broaden-on-error (`attempt` helper) + its tests in
  `test_footage_relevance.py`.
- Enumeration hero/label-fix wiring (`Component.tsx`, `heroState.ts`,
  `enumeration-herostate.test.ts`).
- `preview/next.config.ts` + `tsconfig.json`: the `lucide-react` alias completing the
  Tier-2 lucide wiring (mirror of the render bundler's `remotion.config.ts` alias).
- **`remotion/public/assets/voiceover.wav` untracked + gitignored** — a regenerated TTS
  artifact (the voice stage rewrites it every run; only its *path string* is referenced,
  never the binary). Same class as the already-ignored `enum-gate-*.wav`. Stops it
  shipping as garbage.
- `.gitignore` patterns added for the gate artifacts that slipped past existing rules
  (`enumeration-gate-frames.zip`, `enumeration-gate-frames (2)/`).
