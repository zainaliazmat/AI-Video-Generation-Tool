# Layout ⊥ Theme — Locked Architecture Direction

**Date:** 2026-06-08
**Status:** Direction locked (DOCUMENTATION only — most of this is explicitly deferred, see below)
**Origin:** ruled during the hero-card "empty frames" fix (see
`2026-06-08` hero-card-backgrounds work / Round 1). Recorded so a fresh session
inherits the direction and builds *compatibly* — not so it gets built now.

## The locked direction

### 1. Layout ⊥ theme are orthogonal primitives
- **Layout** (hook / stat / scene / outro / enumeration / …) is **per-scene**: it
  decides *how a single beat is rendered*.
- **Theme** (palette / fonts / transition / caption) is **video-level**: the resolved
  look, applied across all scenes.
- The marketplace ships **either one alone**; a "pack" is just a manifest that bundles
  both. The earlier "atomic-scene vs style-pack" framing was a **false choice** — they
  are independent axes.
- **Naming note:** "layout" is the *conceptual* name. The spec field stays
  `scene.template` for now — **no rename** (see deferred).

### 2. Selection is one pure, idempotent `derive()` function
Not a "pipeline-stage vs live-layer" dichotomy — it is the **same** function called from
two places:
- The **pipeline** calls it **once** to bake defaults into `spec.json`
  (`source: "auto"`).
- The **app** calls it **per-scene** on a user toggle (`source: "pinned"`).
- **Rendering reads ONLY the spec** — never the selector. The renderer stays a pure
  function of `spec.json`.

### 3. Guardrails carried with the direction
- `derive()` only ever picks **WHICH layout renders a given span** — it **never changes
  span count or timing**. The **1 beat = 1 span = 1 scene** invariant holds;
  restructuring (splitting/merging beats) stays in the **script stage**.
- An **AI selection strategy** picks **within the ELIGIBLE set** (eligibility = the
  layout's `inputSchema`), is **validated by `validate.py`**, and **falls back to the
  deterministic strategy**. Same **fails-closed** discipline as the hook fallback, the
  verify pass, and the git-guard.

### 4. Adoption is incremental
- The **manifest capability-declaration standard** and `derive()` get their **first
  brick at the enumeration layout (Round 3)**: its manifest declares its role/eligibility
  and the recipe reads **one declared property** instead of hardcoding the kind.
- **Until then, the recipe's hardcoded `kind → template` mapping stays.** Do not
  refactor it ahead of need.

## Explicitly DEFERRED — do NOT build now
- The `derive()` selector itself.
- The manifest capability standard beyond what already exists.
- Any `template → layout` field rename.
- The user-override UI.
- The AI selector.

## Roadmap this direction must stay compatible with
- **Round 2 (own branch):** hook word-sync — render the hook hero LINE as word-timed
  highlight-in-place (the line already equals the spoken text), driven by faster-whisper
  timestamps. Reopen `rendersOwnText` **carefully** — hero-text-as-timed, **NOT**
  un-suppress (un-suppressing reintroduces the duplication the Phase-3 caption fix
  removed). Hook only; stat word-sync stays blocked behind the label↔narration mismatch
  (Phase-3 residual iii).
- **Round 3 (own mini-project):** the **enumeration layout** (sun/moon/planets/eclipse/
  phases revealed in sync with the spoken words). Curated icon assets (more reliable than
  Pexels here; dodges the relevance trap), per-item timing in props, recipe routing via a
  **declared signal** — the first brick of the capability standard + `derive()`. Still
  one beat = one scene (invariant-safe).
- **Phase-4 footage line (separate — where the SYSTEM_PROMPT + the frozen ①
  query-specificity rule live):** imagery-behind-hero-cards (contract change: optional
  background-media layer + relevance bar, gradient fallback), clip-splitting for long
  beats (script-split into 2 beats vs multi-clip-within-scene), the beat-variety nudge
  (SYSTEM_PROMPT — collides with the frozen ① rule), and the two relevance misses
  (box-drawer, tarot). These force the "which Phase-4 branch folds into which" topology
  call.
