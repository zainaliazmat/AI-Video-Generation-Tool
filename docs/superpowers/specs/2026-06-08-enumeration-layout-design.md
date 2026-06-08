# Round 3 — Enumeration Layout (design)

**Status:** ruled (all eight open questions decided by the reviewer 2026-06-08); ready for plan → TDD → motion gate.
**Branch:** `round-3-enumeration` (off `development` @ `f639d0e`).
**Baseline at branch point:** backend pytest 157 ✓ · vitest 44 ✓ · `tsc --noEmit` green (remotion / preview / templates).

## 1. What we're building

A single narration beat whose content is an **enumerable set** (canonical example: **sun / moon / planets / eclipse / phases**) rendered as those items, each with a curated icon, **revealed one-by-one in sync with the spoken narration**, all inside that beat's single scene/span.

Invariant held throughout: **1 beat = 1 narration span = 1 scene.** Items reveal *within* the one span; they are never split into separate beats/scenes. The audio-sync math, the `spec.json` contract, `rendersOwnText`, and caption suppression stay untouched.

This is the **first cash-in of the capability standard** — the generalization of the `rendersOwnText` precedent. A template declares a capability in its manifest; the consuming code (the recipe) reads it generically without knowing which template it is. It is **one brick**, not the full `derive()` selector (see §6).

## 2. Architecture at a glance

```
script (DeepSeek)         a middle beat carries data.items: ["sun","moon",...]
                          AND narration that speaks them in order
        │                 (prompt-level; no BeatsScript change — data is open)
        ▼
recipe.plan()  ──reads──▶ catalog manifest property  consumes:"enumeration"
 (pure, position+         routes the enumeration-shaped beat to whichever
  data-shape)             template declares that capability (not a hardcoded id)
        │
        ▼
templateProps:{ items:[{label, icon?}], ... }     ← CONTENT in props (recipe-baked)
        │
        ▼
assemble → spec.json  (scenes[].templateProps + per-word captions[])  ← contract UNTOUCHED
        │
        ▼
Video.tsx  ──derives──▶ per-item reveal frames from spec.captions ∩ scene span
 (render-side, like      via an in-order subsequence resolver (reuses normalize())
  Round 2's wordTimings) passes via TemplateProps.itemTimings  ← TIMING render-derived
        │
        ▼
enumeration/Component.tsx  reveals items one-by-one when itemTimings present,
                           else even-staggered entrance (FAIL-CLOSED, set-level);
                           manifest rendersOwnText:true ⇒ caption auto-suppressed
```

## 3. The four decisions (as ruled)

### Decision 1 — The routing signal

**1.1 Data channel: `data.items` (ride the existing open `Beat.data` dict).** No `BeatsScript`/`content.py` change. `data` is the designed extension point; `stat` already rides it untyped as `{value,label}`. The template's zod `inputSchema` is the real contract for item shape — same as stats. Adding a typed `Beat.items` field is rejected: it's a real model-output contract change for marginal benefit and would set the precedent that every new layout grows its own `Beat` field — exactly what the open channel exists to prevent.

**1.2 Capability property: `consumes: "enumeration"`.** A **string enum** on the manifest envelope (a boolean doesn't scale across content shapes). It is **not** named `role` — that word already means position/slot in this codebase and would muddy the layout-vs-role vocabulary. Mirrored in `backend/manifest.py` (Pydantic `Manifest`) and `templates/sdk.ts` (`Manifest` interface), exactly as `rendersOwnText` is mirrored. Optional/absent on every existing template.

**1.3 Slot kind: reuse `kind: "scene"`.** Enumeration occupies the footage-scene slot (a middle beat that isn't a stat), so it genuinely *is* a scene-slot layout; routing is done by `consumes`, not `kind`. **Verified precondition:** `kind` is used only as set-membership/equality (`kind in SCENE_KINDS` in `validate.py`, `== "transition"`/`== "overlay"`, the `main.py:127` transition filter); the catalog is keyed by **id** (`load_catalog`: `catalog[manifest.id] = manifest`). There is **no** `{kind: template}` reverse-lookup anywhere, so two templates sharing `kind:"scene"` is safe. No change to the shared `TemplateKind` Literal or `SCENE_KINDS`.

> **Watch-item:** `backend/tests/test_manifest.py:87-89` asserts hero/own-text templates set `rendersOwnText:true` and footage templates set it `false`. The enumeration template sets `rendersOwnText:true` and must be classified on the **own-text** side of that test, not the footage side.

**Routing mechanics.** Today `recipe.plan()` is called *without* the catalog (`main.py:83`) and maps role→id via a hardcoded `_DEFAULT_TEMPLATES`. First brick:
- `main.py` passes the existing `catalog` into `plan()`.
- `recipe.py` gains `_is_enumeration(beat)` (a data-shape predicate analogous to the existing `_is_stat`) — fires when a **middle** beat carries `data.items`.
- A qualifying beat routes to the template whose manifest declares `consumes == <the enumeration capability constant>` — read generically from the catalog, **not** a hardcoded id.

### Decision 2 — Per-item timing

**What Round 2 implemented (for the record):** timings are **render-derived** from `spec.captions ∩ scene span`, computed in `Video.tsx`, passed via the optional render-only `TemplateProps.wordTimings`; the component **fails closed** to a non-synced entrance if absent/mismatched. Round 2 made **no spec/backend timing change**. Source of truth = the audio-derived caption stream.

**2.1 Ruling: content in props, timing render-derived (match Round 2).**
- **CONTENT** (item labels + resolved icons) rides in `templateProps`, baked by the recipe. This *is* what the handoff's "in props" lean was always about, and content belongs in props.
- **TIMING** (per-item reveal frames) is **render-derived** from captions, mirroring Round 2, passed via a new optional `TemplateProps.itemTimings`.

**Robust rationale (banked correction):** the load-bearing reasons are **(a) recipe purity** — `plan()` is a pure position+data-shape function that runs *before* timing (`main.py:83` precedes `timing.transcribe_words()` at `main.py:97`); reading captions into it would couple composition to audio and break its determinism/testability — **(b) single source of truth** — `spec.captions` (audio-derived by faster-whisper) is *the* timing ground truth; the render-side aligner already derives per-element timing from it, and baking per-item frames anywhere upstream (recipe *or* assemble) creates a second, divergent derivation that splits the source of truth — and **(c) reuse of the gate-proven aligner** (Round 2's `normalize()` + span-filter + fail-closed machinery).

> Explicitly **drop the shaky plank** "frames don't exist until assemble." It's misleading: by assemble time (`main.py:108`, after timing at `:97`) word frames *do* exist. The verdict holds regardless — a pure recipe shouldn't read captions, and a second derivation splits the source of truth — but that is the rationale of record, not the timing-availability claim.

**Alignment (harder than Round 2 — flagged).** Round 2's `alignHookWords` marches a single pointer demanding a **contiguous prefix** match, which works because the hook line *is* the verbatim narration. Item labels are **scattered tokens** inside a richer sentence, so Round 3 needs a **new in-order subsequence resolver**: reuse `normalize()` + the span-filter, then for each label (in order) advance through the per-word captions until it matches (multi-word labels match consecutive caption words; the moving pointer assumes spoken order, which the script controls). A match yields that word's `startFrame` (rebased scene-relative) as the item's reveal frame.

**2.2 Fail-closed: set-level all-or-nothing.** If any item fails to resolve, or order is violated, the resolver returns `null` and the component falls back to a uniform **even-staggered entrance** (still one-by-one motion, just not voice-locked) — mirroring Round 2's discipline. A uniform fallback reads as intentional where a half-synced/half-interpolated reveal would read as broken. Per-item graceful degradation is a noted **future refinement**. If the fallback fires *often* at the gate, that's a signal to revisit 2.3, not to ship un-synced reveals.

**2.3 Matching tolerance: NOT strict — bounded.** Strict normalized-equality is too brittle for the dominant real case (singular label vs plural spoken: "planet" vs "the planets"). Leaning on the model to speak labels verbatim is the same soft lever as the residual gigatonnes/gigatons clash. So: **exact normalized match first, then a bounded prefix/plural match gated by a minimum length (~4 chars), in-order, exact-before-prefix** (to avoid greedy mis-grabs). The vitest cases must cover: plural↔singular, article-skipping ("the"/"a"), multi-word labels, **and a deliberate false-positive guard** (e.g. "sun" must not match "sunday" — the ~4-char min + exact-before-prefix ordering enforces this).

### Decision 3 — Icons

**3.1 Curated emoji, as the floor (not the finish).** Mirrors the proven `stat.icon` convention (a string glyph rendered at large `fontSize`), zero deps, license-clean (Unicode emoji are not copyrighted — *more* redistributable than any SVG set for the npm/marketplace trajectory). Named the **floor**: emoji aren't theme-tintable and full-color glyphs can read cheap against the palette gradient — a **pixel** claim held for the gate. If they read cheap, the upgrade is **B** (a tintable ISC/MIT/Apache SVG set) with the architecture already proven.

> **Front-loaded gate (load-bearing assumption):** render a headless-Chromium **emoji still at size early (≈ sub-gate 1), before the component is built on top of it.** If color emoji don't render in the box (tofu), option A collapses to B and we pivot before sinking component work. Include that still in the upload.

**3.2 Fallback mark: neutral, semantically-empty** (a filled dot `●` or small diamond), sized to match the real glyphs. Gradient-as-floor logic: a meaningless mark beats a wrong specific icon. Frequent fallback in a render signals a missing-curation content task, not an architecture problem.

**3.3 Mapping: template-curated; script supplies labels only.** The template owns a deterministic curated `label → glyph` lookup (normalized match) + the generic fallback. The script/recipe lists item **labels** only. Asking the model to emit icon ids would invent a new error class and a new validation surface; a deterministic lookup is testable where model-supplied icons wouldn't be, and the template is the right home for its own visual vocabulary (consistent with the self-contained-plugin model).

### Decision 4 — First-brick scope (hold the line)

Build **only**: the one `consumes` capability + the recipe reading it for *this* template; the plugin folder (manifest/zod/Component); the curated icon helper; the render-derived item-timing resolver + its `Video.tsx` wiring.

Do **NOT**:
- build the general **`derive()` selector** — add *one* property-driven routing branch; the existing hook/outro/stat/scene routing stays hardcoded. The temptation to "tidy" all routing into declared properties **is** building `derive()` early; the diff must not do it.
- **rename** anything — the spec field stays `scene.template`.
- build an **AI selector** — routing stays deterministic (content predicate + declared-property lookup).
- build an **override UI**.

## 4. Build flags (reviewer conditions)

1. **Predicate precedence / mutual-exclusivity.** A beat carrying *both* `data.value`/`label` and `data.items` must route deterministically. Rule: **stat-then-enumeration is mutually exclusive at the predicate level** — `_is_enumeration` requires `data.items` present *and* the beat is not stat-shaped (no `value`+`label`), so a malformed both-fields beat resolves to `stat` (the existing, earlier-precedent path) rather than being ambiguous. Covered by a test.
2. **One shared capability constant.** `_is_enumeration` identifies the *needed capability*, and routing finds the template declaring `consumes: <that same constant>`. The literal `"enumeration"` lives in **one** place (a module constant) referenced by both sides — never two independently-hardcoded strings that can drift.
3. **Renamed-fake-template routing test (the cash-in proof).** A test where a differently-*named* template declares `consumes:"enumeration"` and the enumeration-shaped beat still routes to it. This is the explicit proof that this is the first brick of the capability standard, not a hardcoded enumeration branch.

## 5. Touch-point classification

**(a) plugin-local — normal path**
- `templates/enumeration/` → `manifest.json`, `schema.ts` (zod inputSchema), `Component.tsx`
- curated `label → glyph` pure helper (like `heroBackground.ts`); pure item-reveal-state helper (reuses the `hook-reveal.ts` shape)
- `gen-manifests` + `build-registry` regen of `registry.generated.ts`
- enumeration manifest sets `rendersOwnText:true` — **consuming** the existing flag (free caption suppression)

**(b) backend-internal / upstream — flagged**
- `recipe.py`: `_is_enumeration` predicate + `consumes`-driven routing; `main.py` passes `catalog` into `plan()`
- `manifest.py` + `sdk.ts`: add the `consumes` string-enum to the Manifest envelope (the `rendersOwnText` precedent, mirrored both sides)
- `script.py`: prompt to elicit `data.items` + in-order narration (prompt-level; backstop = a beat without items is just a normal scene)
- render-side timing: new item-timing resolver in `remotion/src/` + `Video.tsx` wiring + optional `TemplateProps.itemTimings` (**same precedent as Round 2's `wordTimings`** — render-derived, optional)

**(c) MUST stay untouched — confirmed**
- **spec.json contract** (`schema.py`/`schema.ts`) — items/timings ride existing `templateProps`/`captions` ✓
- **audio-sync math** (assemble/frames) ✓
- **`rendersOwnText` behavior + caption-suppression** — reused, not modified ✓
- **`Beat`/`BeatsScript`** — unchanged (Decision 1.1) ✓
- **1 beat = 1 span = 1 scene** ✓

## 6. Build infra fix (folded in)

`templates/` has no local `tsc`, so its `npm run typecheck` silently fails to a bare-`tsc`-not-found. Since the enumeration plugin lives in `templates/`, **fix this as part of the build** (give `templates/` a real `tsc` — local devDependency or invoke the workspace binary) so the new plugin's types are actually gated, not skipped.

## 7. TDD sub-gate sequence (RED→GREEN; pytest + vitest + tsc stay green)

0. **Scaffold + codegen** — create the folder; RED: registry/catalog includes `enumeration`, manifest envelope validates. GREEN: run `gen-manifests` + `build-registry`; `load_catalog` picks it up.
1. **zod inputSchema + validation** — RED: zod tests (valid `items` pass, malformed fail `.strict()`) + pytest that enumeration `templateProps` validate against the generated `inputSchema`. GREEN: finalize schema, regen. **+ front-loaded emoji still here.**
2. **Routing (Decision 1 + build flags)** — RED: `plan()` routes a `data.items` middle beat to the enumeration template **via `consumes`** (catalog injected); non-enumeration middle → `scene`; position still wins (beat 0 → hook, last → outro); stat-vs-enumeration precedence; **renamed-fake-template** test. GREEN: predicate + capability constant + `consumes`-read routing + `main.py` wiring + envelope property (manifest.py↔sdk.ts mirror test).
3. **Item-timing resolver (Decision 2)** — RED: vitest on the pure resolver — in-order subsequence, multi-word labels, plural↔singular, article-skipping, whisper number/hyphen artifacts, false-positive guard ("sun"≠"sunday"), fail-closed→`null` on unresolved/out-of-order. GREEN: implement (reuse `normalize`).
4. **Component reveal + fail-closed + icons + wiring (Decisions 2/3)** — RED: vitest on pure item-reveal state + icon lookup (label→glyph, generic fallback); caption-suppress derivation covers the enumeration span. GREEN: Component renders one-by-one when `itemTimings` present, else even-staggered; `Video.tsx` computes `itemTimings` for the enumeration scene; `rendersOwnText:true`.
5. **E2E + full green** — a spec with an enumeration scene validates + renders (no `MissingTemplate`); tsc green all packages; pytest 157+Δ, vitest 44+Δ.

## 8. Motion gate artifact

Render the canonical **sun / moon / planets / eclipse / phases** beat specifically — the handoff's example *and* the Antikythera video's tarot-miss beat, so the gate doubles as proof the layout fixes that beat. Produce and upload to `/mnt/user-data/uploads`:
- a short **MP4** of the beat,
- a **dense entrance-spanning frame strip**,
- a **per-item-onset table** (ground-truth word-onset frames vs observed reveal frames, à la `hook_gate.py`),
- a **fail-closed strip** triggered by a *realistic* failure (a plural mismatch beyond tolerance or out-of-order), not an artificial null,
- the **front-loaded emoji still** (so glyph rendering/legibility at size can be confirmed).

A synced reveal is a motion artifact by construction — stills won't close it. **Pause at the gate; the reviewer rules the reveal on the pixels.**

## 9. Workflow

Feature branch `round-3-enumeration` → PR into `development` (operator's manual action) → operator merges to development → (separately, later) operator opens development→master PR. Commits land **only** on the feature branch; never on `development` or `master`. No push/PR/merge by CC. Surface "ready for the operator to PR" once the motion gate is signed off.
