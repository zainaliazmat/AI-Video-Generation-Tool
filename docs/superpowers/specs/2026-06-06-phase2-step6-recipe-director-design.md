# Phase 2 — Step 6: Recipe / Director + Validation — Design

**Date:** 2026-06-06
**Status:** APPROVED 2026-06-06 (decisions locked below). Build 6.1→6.4; stop for review after 6.2 and 6.4.
**Spec authority:** `claude-code-template-plugin-phase-prompt.md` §6 (composition/director),
§2 (input-schema bridge), §3 (slots), §4 (spec additions); §9 step 6; §11 acceptance.
**Prereqs:** Steps 1–5 of the template system. Steps 1–4 done & committed (`611ae96`):
contract, registry, render templates (hook/scene/stat/outro/overlay) + transitions
(fade/slide) through `<TransitionSeries>` with the verified `seqDurᵢ = dᵢ + Tᵢ`
audio-sync invariant. Step 5 (gallery) intentionally deferred to AFTER step 6.

## Goal

Make the pipeline produce **real multi-template videos**. Today `assemble.build_spec`
emits one `scene`-template scene per narration line — every video is N identical
footage scenes. After step 6: `python backend/main.py --topic "..."` →
`hook → scene(s)/stat(s) → outro`, transitions between them, props filled from
DeepSeek's structured content + theme, the whole thing **validated** against each
template's input schema before it can render.

---

## The two constraints you carried in (pinned)

1. **Composition is deterministic — the model never asserts `kind`.** DeepSeek emits
   narration `text` + optional structured `data` only. The **recipe** derives
   slot/template from position + data shape (numeric/value-shaped `data` → `stat`).
   If we later want number-bearing data to render differently, we change the recipe,
   not the model. That is the reliability property.

2. **Clip-length `≥ dᵢ + Tᵢ` needs a graceful fallback, not an assert.** At volume,
   Pexels clips will sometimes be shorter than the span the renderer plays them for
   (a footage scene with an outgoing transition plays `dᵢ + Tᵢ` frames). A short clip
   must degrade gracefully (default: **loop**), never fail the render.

---

## Core design decision: every beat is narrated; the recipe only chooses the renderer

The cleanest way to keep the entire audio-sync architecture intact is to keep the
existing invariant **1 beat = 1 narration span = 1 scene**, and let the recipe decide
only *which template renders each span*:

```
beats (from DeepSeek)          recipe derivation (deterministic)        scene plan
─────────────────────          ─────────────────────────────────       ──────────
beat[0]            ───────────▶ position 0                  ──────────▶ hook
beat[i]  data:{value,label} ──▶ value-shaped data           ──────────▶ stat   (no footage)
beat[i]  (no stat data)     ──▶ default                     ──────────▶ scene  (footage)
beat[last]         ───────────▶ last position               ──────────▶ outro
                               theme.transition between consecutive scenes ▶ fade/slide
```

Consequences (all good):
- **hook / stat / outro are narrated** (narration plays over the title card / big
  number / CTA). No silent inserted scenes; `total = Σdᵢ = voiceover length` stays true.
- **Captions** stay timed against the full back-to-back voiceover, at the composition
  root on absolute frames — unchanged, and correct regardless of which template renders
  a span or what transitions overlap.
- **Footage** is fetched *only* for `scene`-kind beats (hook/stat/outro need none),
  cutting Pexels calls and removing "no clip for a title card" failure modes.
- The model writes good narration; the recipe owns structure. Swapping the recipe
  (e.g. a `"myth-vs-fact"` content type later) changes composition with zero model
  or template changes.

---

## Data contracts — two distinct schemas (don't conflate them)

**A. Content schema** — what DeepSeek returns (validated when parsing the LLM reply):

```jsonc
{
  "title": "string",
  "beats": [
    {
      "text": "one spoken narration sentence",   // required, drives TTS + captions
      "data": { "value": "90%", "label": "of the ocean is unexplored" },  // optional
      "keywords": "deep ocean trench"            // optional, footage search hint
    }
  ]
}
```
- `data` is optional & generic; the recipe inspects its *shape*, the model never names a
  template. `keywords` improves Pexels relevance for footage beats (falls back to `text`).
- Validated by a new Pydantic model `BeatsScript` (+ retry-once on invalid). Pydantic is
  the **portable** guarantee — `LLM_PROVIDER` is pluggable (deepseek/ollama/anthropic),
  so we do NOT rely on provider-specific `json_schema` structured-output modes; we keep
  `response_format=json_object` + schema-in-prompt + Pydantic validation.

**B. Template inputSchema** — the zod→JSON-Schema bridge (§2). Validates the
`templateProps` the recipe produces, before render. Per-template. (Detail below.)

These are different layers: A guards *what the model produced*; B guards *what the recipe
composed*. Both are "validation"; conflating them is a trap.

---

## Pipeline reordering

Planning is audio-independent (template choice comes from position + data), so the
recipe's **plan** runs right after `script`, and `footage` consumes the plan:

```
 old:  script ──────────────▶ tts ─▶ timing ─▶ footage(all lines) ─▶ assemble
 new:  script ─▶ recipe.plan ─▶ tts ─▶ timing ─▶ footage(plan.footage_beats) ─▶ assemble ─▶ validate
                    │                                                  ▲
                    └──── scene plan (templates, props, queries) ──────┘
```

---

## Modules

### `script.py` — structured content (sub-step 6.1)
Emit `BeatsScript` instead of `{title, lines[]}`. New system prompt: narration beats
(8–18 words), attach `data:{value,label}` only when a fact centers on a striking number,
optional `keywords`. Parse → `BeatsScript.model_validate` → retry once on failure, then
fail loudly. The hook/outro narration are just the first/last beats (model writes them as
"open with a hook" / "close with a call to action"); the recipe assigns the templates.

### `recipe.py` — the director (sub-step 6.2) — **the brain; review hardest**
Pure, I/O-free, the reliability core:
```
plan(beats, *, recipe="fact-list", theme) -> ScenePlan
```
- One recipe to start: **`fact-list`**. Derivation table (deterministic):
  - index 0 → `hook` (props: `{title, subtitle?}` from beat text / script title)
  - last index → `outro` (props: `{title, cta?}`)
  - middle beat with value-shaped `data` → `stat` (props from `data`; **no footage**)
  - else → `scene` (footage; `query = beat.keywords or beat.text`)
- **Transitions (SELECTIVE default — locked #3):** hard cuts by default; emit a
  `theme.transition` *intent* only at **emphasis boundaries — into a `stat`, into the
  `outro`**. Density is a recipe knob (`transition_policy`), default `selective`
  (alternatives: `none`, `every`). `Tᵢ` chosen within the transition template's
  `durationFrames.min/max`; since `dᵢ` is audio-derived, the plan emits intent
  `{template, props}` and `assemble` resolves+clamps `Tᵢ ≤ min(dᵢ, dᵢ₊₁)`; final scene
  gets none.
- Output `ScenePlan = [PlannedScene{role, template, props, needs_footage, query?,
  transition_intent?}]`. Props are built from `data` + `theme`; `theme` carries no
  per-scene secrets, templates already theme themselves.
- **Heavily unit-tested** — the derivation table IS the contract. Fixture beats →
  expected plan, including edge cases (1 beat, all-stat, no-stat, data present but malformed).

### Validation + zod bridge (sub-step 6.3)
- Swap each `templates/<id>/schema.ts` from a plain-TS interface to a **zod** schema
  (single source of truth, §2). Add `zod` + `zod-to-json-schema` to the template
  toolchain (build-time only; templates keep peerDeps-only at runtime).
- Extend `build-registry.mjs` (or a sibling `gen-manifests.mjs` it calls) to import each
  template's zod schema and **write its JSON Schema into `manifest.json`'s `inputSchema`**,
  replacing today's hand-authored placeholder. Deterministic output; runs in the same
  dev/build/render hook as the registry.
- Python `validate.py`: for each scene/layer, look up its template's manifest
  `inputSchema` and validate `templateProps`/`props` against it (jsonschema), enforce
  **slot rules** (a `transition` id can't sit in `scene.template`; `scene.transition`
  must reference a `transition`-kind id; `layers[].template` must be `overlay`-kind),
  and re-check the spec envelope. A bad prop/slot **fails loudly, before render** (§2
  "fail fast at volume"). This is also the runtime backstop behind the renderer's
  type-level discrimination from step 4.

### `footage.py` — fetch by plan (sub-step 6.4)
Take the footage beats from the plan (not every line); query = `keywords or text`; cache
unchanged. **Record each clip's duration in frames** (ffprobe on the downloaded file) on
the `Clip` contract, so assemble can enforce the clip-length fallback.

### `assemble.py` — bind plan + timing + clips → validated spec (sub-step 6.4)
- Consume `ScenePlan` + tts offsets (`dᵢ`, `Sᵢ`) + word timings + footage clips.
- Build one scene per beat with the planned `template`/`templateProps`,
  `startFrame=Sᵢ`, `durationInFrames=dᵢ`. Resolve each transition intent into a concrete
  `Transition{template, durationInFrames=Tᵢ, props}` with `Tᵢ` clamped per above.
  (The renderer does the `seqDur=dᵢ+Tᵢ` overlap math — assemble only sets `dᵢ` and `Tᵢ`.)
- **Clip-length fallback:** for a footage scene, required span = `dᵢ + Tᵢ`. If the clip is
  shorter, set the media's loop policy so the clip repeats to fill the span (Open Q2);
  a clip long enough is trimmed at span end as today. Requires an additive optional
  `media.loop` (or `media.shortClipPolicy`) field on the spec + the `scene` template
  honoring it via Remotion `<Loop>`/`Video loop`. Only a 0-frame/corrupt clip fails loudly.
- Emit `layers`/`captions`/`theme`/`audio`/`meta` as today; run `validate` before writing.

### `main.py` — reorder
`script → recipe.plan → tts → timing → footage(plan) → assemble → validate → write`.
Keep the `--progress-json` stepper; `recipe` is fast/local so it can fold into the
`assemble` or `script` stage label, or get its own — minor (Open Q4 is unrelated).

---

## Sub-step gating (each its own checkpoint, like everything else)

| # | Scope | Checkpoint |
|---|-------|------------|
| **6.1** | Structured content contract + `script.py` rewrite + tests | `script.py --topic` returns a valid `BeatsScript`; unit tests green |
| **6.2** | `recipe.py` director + derivation table + transitions (pure) | Fixture beats → expected `ScenePlan` (derivation table fully unit-tested) |
| **6.3** | zod swap + manifest JSON-Schema codegen + `validate.py` (slots + props) | A bad prop / wrong-slot id fails loudly; sample specs validate; all typechecks green |
| **6.4** | footage-by-plan + clip-duration + `assemble` rewrite + clip-length fallback + `main.py` reorder | **The big one: first real multi-template video rendered E2E from a topic** (hook→scene/stat→outro, transitions, audio-synced) |

### zod→JSON-Schema codegen mechanism (6.3, second half) — user-gated & DONE
Mechanism chosen by the user: **templates-local dev toolchain.** `templates/package.json`
gains `tsx` + `zod` + `zod-to-json-schema` as **devDependencies**; `templates/.npmrc`
(`legacy-peer-deps=true`) keeps react/remotion OUT of `templates/node_modules` (verified —
only 5 pkgs added, no peer leak), preserving the single-copy dedupe in consumers. Each
content template authors its input contract once as a zod `schema` in `<id>/schema.ts`
(single source of truth); `scripts/gen-manifests.ts` (run via tsx) exports it to that
template's `manifest.json.inputSchema` (JSON Schema), replacing only that field. zod is a
**TYPE-only import** in the Components (`z.infer`), and `schema.ts` is imported as a runtime
value ONLY by the build-time codegen — so zod never enters the render bundle. `.strict()` →
`additionalProperties:false`. The codegen is wired **best-effort** into `build-registry.mjs`
(runs before discovery; SKIPS with a warning and falls back to committed inputSchemas when
the toolchain is absent), so the render/build hot path never hard-depends on it. Verified:
all 4 real specs validate against the regenerated manifests; remotion + preview typecheck
green (zod resolves from `templates/node_modules`); 91 backend tests green.

### Pixel-locked taste calls (2026-06-06, on the stat-bearing render + an independent design panel)
A second live render forced a stat-rich plan (hook → stat·3 hearts → scene → stat·9 brains →
scene → stat·66% → outro, fades into all 3 stats + outro). A 3-critic design panel (grounded in
the rendered stills) locked the three deferred calls:
1. **Hook text → KEEP topic-as-title.** Reads strong/dominant on frame 60. (Open polish, not done:
   the spoken-hook subtitle is dim grey + often restates the title — brighten/trim later.)
2. **Stat presentation → KEEP full-frame number on black** (panel REVERSED the earlier lean toward
   stat-over-B-roll): a number over footage desaturates and camouflages into the clip (frame 382 —
   "9 brains" went dim olive), killing the pop a stat needs; full-frame yellow-on-black punches and
   gives rhythmic contrast to the footage scenes. Over-B-roll only viable later WITH a dark scrim.
3. **Fade rhythm → KEEP selective cadence, HARD-CUT text→text boundaries.** Implemented: selective
   fires into a stat/outro ONLY from a footage `scene` source; text-card→text-card (hook→stat,
   stat→outro, stat→stat) hard-cuts (a crossfade double-exposes two centered text cards — frames
   149/798). Footage→text fades stay. `recipe._assign_transitions` + 2 tests (93 backend green).

### Status update (2026-06-06)
- **6.3 DONE (both halves).** The `validate.py` half is DONE (`load_catalog` + `validate_spec`: per-template
  JSON-Schema props + slot/kind rules; 10 tests; all 4 real specs validate). The **zod→JSON-Schema
  codegen half is DEFERRED to a gated mechanism proposal** — it's the bundler-sensitive piece
  (no tsx/ts-node exists; `templates/` has no `node_modules`; build prompt §1 says to confirm the
  codegen mechanism against the bundlers). `validate.py` runs against the already-correct
  hand-authored manifest `inputSchema`s, so it didn't block the value chain.
- **6.4 DONE & rendered E2E (live).** `topic → DeepSeek beats → recipe → Kokoro → whisper → Pexels →
  assemble → validate → render`. First real multi-template video: hook (topic title + spoken-hook
  subtitle) → 5 keyword-relevant footage scenes (Ken Burns) → outro (CTA), fade cross-dissolve into
  the outro, word-synced captions, gap-filling contiguous timing. 91 backend tests green; remotion +
  preview typecheck green; render EXIT=0 (47.7 MB / 936 frames). This generation emitted no numeric
  beats so no `stat` scene rendered, but the live recipe smoke-test confirmed stats land correctly
  (`3 hearts`, `500M neurons` → stat) and the unit tests cover the stat/transition paths.
- **Prop-filling decision JUDGED ON PIXELS (was the flagged taste call):** topic-as-title reads
  strong on the rendered hook; keeping the current mapping (no flip to spoken-hook-dominant).
- **Clip-length loop fallback:** mechanism in place (`media.loop` → scene template `<Video loop>`,
  since OffthreadVideo has no `loop` in Remotion 4.0.472) and unit-tested at the spec level; not
  visually exercised in this render because the selection bias kept every clip long enough.

I'll stop for your review after **6.2** (the brain, before it touches I/O) and again at
**6.4** (the E2E checkpoint you named).

---

## Locked decisions (user-approved 2026-06-06)

1. **Hook/outro = positional. LOCKED.** Beat 0 → hook, last → outro, every beat narrated.
   No model-tagged role field (that lets the model back into composition). Recipe must
   handle **N=1 and N=2 gracefully** (e.g. N=1 → single hook? or single outro? — define in
   6.2; N=2 → hook + outro, no middle). Script prompt must reliably open hook-like and
   close CTA-like.

2. **Clip fallback = measure-then-loop. LOCKED, with a selection bias.** Loop is explicit
   in the spec (`media.loop`) and fires only when measured length `< dᵢ+Tᵢ`. Because the
   new ordering runs `footage` AFTER `timing`, `dᵢ` is known at fetch time — so **bias clip
   *selection* toward clips long enough to cover `dᵢ + transition_max`**, making the loop
   fallback rarely fire. Loop stays the last resort. Slow-to-fit for tiny shortfalls is a
   possible future nicety if seams look bad — **do not build it now**.

3. **Transition density = SELECTIVE by default. LOCKED (user steered).** "Between every
   scene" reads busy/dated for short-form; **hard cuts are the default**, with the
   `theme.transition` (fade/slide) reserved for *emphasis* — **into a `stat`, into the
   `outro`**. Density is a **recipe knob**; default selective, dial up after seeing real
   renders. Same `Tᵢ ≤ min(dᵢ, dᵢ₊₁)` clamp, resolved in `assemble`.

4. **stat vs scene = stat-wins. LOCKED for now.** Value-shaped `data` → full-frame `stat`,
   no footage. **Future upgrade (not this step):** a stat animating *over* relevant B-roll
   is richer — that's a new composition once E2E works.

**Brand-bug overlay:** skip this step (trivial to add later). LOCKED.

**Prop-filling (recipe 6.2) — shipped as-is, JUDGE AT THE 6.4 RENDER.** Current mapping:
`hook = {title: script.title, subtitle: beats[0].text}`, `outro = {title: beats[-1].text}`,
`stat = {value,label,icon?}`, `scene = {}`. This is the one taste call; eyeball it on the
first real hook frame at 6.4. **If topic-as-title reads weak/generic, flip to making the
spoken hook line the dominant text** (it's the attention-grabber and syncs with audio) and
demote the topic — a one-liner either way. Stat slipping to scene because the model emitted
`value` without `label` → fix in the SCRIPT PROMPT (always pair them), not by loosening the
recipe. Possible later refinement (not now): bracket a stat with an *out*-transition too
(hard-cut out) — a "see how it feels" call at 6.4.

## Two technical notes carried from review
- **Clip duration:** check whether the **Pexels response already carries clip duration**
  (`videos[].duration` / `video_files[].fps`+frames) before reaching for `ffprobe` — it
  usually does, saving a subprocess dependency. Prefer the API field; ffprobe only as
  fallback.
- **LLM robustness:** retry-once-then-fail is fine for v1. **Note (don't build):** at batch
  volume, add a repair pass or a couple more retries so one bad LLM reply doesn't kill a
  batch.

---

## Testing
- 6.1: `BeatsScript` validation (valid/invalid/retry) with a stubbed client.
- 6.2: derivation table truth-tests (the reliability core) — every rule + edge case.
- 6.3: JSON-Schema codegen determinism; `validate.py` pass/fail fixtures (bad prop,
  wrong-slot id, missing required); typechecks across remotion/preview/templates.
- 6.4: golden `ScenePlan → spec.json`; clip-length fallback (short clip → loop policy set);
  one live E2E render.

## Not this step
Step 5 gallery + MP4 previews (next). `lower-third` template (kind declared, no template).
Multiple recipes beyond `fact-list` (contract supports them; we ship one). Provider
`json_schema` structured-output modes (Pydantic validation is the portable path).
