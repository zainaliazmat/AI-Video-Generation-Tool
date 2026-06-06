# Phase 3 — Script v2: Stronger Hooks + Factual Grounding

> **Status:** Pre-build findings & design — awaiting "go" before any code.
> **Date:** 2026-06-06
> **Source prompt:** [claude-code-phase3-script-grounding-prompt.md](../../../claude-code-phase3-script-grounding-prompt.md)
> **Scope:** the **script / content layer** only. Platform/scale work (batch, cloud render, more recipes) is explicitly a later phase.

---

## ✅ Approved & locked (2026-06-06)

Shape approved: **grounding before hooks**, **sidecar over render-contract churn**, **auto-pick hooks** to keep the spine headless.

- **Q1 — cost:** locked — **≤ 1 Tavily + ≤ 2 LLM** baseline; **≤ 4 Tavily + ≤ 3 LLM** with verify; all retrieval cached.
- **Q2 — scope:** `sources.json` sidecar is **in the spine (3.1)**; on-screen stat citation stays a **3.3 opt-in**.
- **Q3 — Tavily client:** **`requests`, not the SDK** — verify endpoint/auth against live docs first.

**Three rigor steers folded in (all inside the cost bounds):**

1. **Strict grounded generation (in the spine, 3.1).** The model states **only** what the retrieved snippets support, cites the **specific** snippet/URL it used, and marks a beat ungrounded / drops it when nothing supports it. Citations are trustworthy **by construction**, not merely present — a citation that doesn't back its claim is worse than none for an accuracy-selling audience.
2. **Verify pass default-on for client output (3.3).** One batched self-check against the already-retrieved snippets (**zero extra Tavily**). Skippable for reach-only runs; anything client-facing runs it.
3. **Grounded hooks (3.2).** Hook candidates are drawn from the **grounded facts** — the most striking *true* fact framed punchily, **never invented**. This is the one place the two pillars can collide; building hooks after grounding sets it up, and the constraint is made explicit in the hook step.

---

## 🔬 E2E validation (2026-06-06)

First live grounded run — topic *"3 surprising facts about the deep ocean"* → 5 beats `[hook, stat, scene, stat, outro]`, `spec.json` (635f) + `sources.json`, rendered to an 18.4 MB MP4. **The spine works:**

- Real Tavily returned exactly the parsed shape (6 results, `title/url/content/score`).
- DeepSeek **obeyed** the strict-grounding prompt: every factual beat carried a **real retrieved URL**; core facts (Everest comparison, 11 km Challenger Deep, 700°F vents) are **supported by the retrieved snippets**.
- `_enforce_grounding` held — no hallucinated URLs; **both** stats kept valid citations.
- `sources.json` reads sensibly (client-presentable).

**Two limitations surfaced — both are 3.3 verify-pass territory, not spine flaws:**

1. **Real-but-non-supporting citation.** The beat *"only three people have ever visited that depth"* cited a real retrieved URL whose snippet does **not** contain that claim (and it's factually stale). The spine guarantees *real URL*, not *supports this claim* — **this is the verify pass's core job.**
2. **Single-source citation.** DeepSeek cited one source for all four facts though 6 diverse ones were retrieved — per-claim source specificity is weak. Verify can re-attach the best-matching source per claim.

**Folded into 3.3:** the verify pass is **default-on for client output**, and must **flag/demote a `stat` that loses (or lacks valid support for) its citation** — an on-screen number with no supporting source is the worst case for the accuracy goal.

---

## 🎬 3.2 validation (2026-06-06)

Hooks + the prompt nudge, validated on a re-run (same topic; Tavily cached, DeepSeek regenerated):

- **Deliberate hook selection:** 5 grounded candidates scored deterministically; the winner (4.0 — a grounded number + question) became beat 0. Candidates retained in `sources.json` for inspection.
- **Hook is the hero:** the spoken hook renders large / high-contrast; the topic is a small accent kicker (the buried-grey-subtitle problem is gone). Confirmed on the render.
- **Nudge closed both gaps:** the unsupported "three people" claim was **omitted from the facts** (it survived only as a non-chosen hook candidate); per-claim source matching produced **2 distinct, correctly-attributed sources** (was 1-for-all).

**Carry-forward (not 3.2 regressions):**
- **Stat value auto-fit** — a long value ("37,700 gigatonnes") overflows the frame; fix = fit the stat value to width (handles too-long *and* too-short). Same root as the Phase-2 single-digit-scaling item. → near-term polish, stat template only.
- **De-dup nudge (3.3)** — "stats should cover facts not already in the hook" (mild hook/stat overlap: comparison in the hook, absolute in the stat).
- **Footage relevance (later phase)** — weak / off-message clips ("deep ocean" → lakeside litter); the footage-relevance lever, out of Phase 3 scope.

---

## 🛡️ 3.3 validation (2026-06-06)

The verify pass (default-on for client output) + hook-drop + floor handling, validated E2E:

- **Verify:** ONE batched DeepSeek check per claim against its retrieved snippet; a **coverage guard** default-denies any beat the verifier omits (never ships unverified); the rescue is **batched** (≤2 verify calls/video); a **targeted per-claim Tavily lookup** rescues a true fact the broad search missed before any drop — all within the ≤4-Tavily / ≤3-LLM bound. On the run, all 6 facts verified-and-kept; verdicts recorded in `sources.json`.
- **Verdict → action:** spoken-claim-unsupported → **DROP**; only-the-number-unsupported (narration stands) → **DEMOTE** (strip the on-screen number, keep the scene). The spoken claim is the test, since it's what reaches the viewer.
- **Hook-drop:** if the chosen hook fails verification, **re-select** the next-best grounded candidate (re-verified in one batched check); fall back to the title as a non-asserting opener if none verify.
- **Floor:** **count-agnostic titles** ("Deep Ocean Secrets…", no "N facts") so a dropped fact never leaves a stale count; a **two-tier floor over surviving claims (kept + demoted, excl. hook/outro)** — **hard-fail at 0** (refuse a claimless video), **warn at 1**; no regeneration (stays in budget).
- Stat value **auto-fit** confirmed on "37,700".

**Residual — top of the next queue (not a blocker):** the de-dup nudge is a soft prompt instruction — a chosen hook can still echo a body fact (700°F here), which reads as a bug to a viewer even though it's technically correct. A post-selection de-dup (drop a body beat that restates the chosen hook) closes it — small, but when it drops a beat it must count toward the fact floor. **Footage relevance** stays a separate later phase.

**Phase 3 definition of done — met:** factual claims grounded in retrieved sources with citations; a deliberately generated/selected, grounded hook; sources surfaced (sidecar); full pipeline E2E green; provider stays DeepSeek; all changes additive; new shapes TDD'd. **135 tests green.**

This document is the `§0` deliverable from the build prompt: a map of the current
path, the constraints the code imposes, rulings on the open decisions, and a
sub-step plan with gates. It is the single read-everything reference for the phase.

---

## TL;DR

Phase 3 upgrades **what the script says**, not how it's composed:

1. **Hooks (reach):** the opening beat becomes *deliberately generated and selected*
   from several candidates, not a side-effect of one generation pass.
2. **Grounding (credibility):** the script is grounded in real retrieved sources
   (via **Tavily**), and each factual beat carries a **citation (source URL)** —
   handed to clients and used as stronger hook material.

Everything is **additive and optional**. DeepSeek stays the LLM. The recipe still
owns composition deterministically. The render contract (`spec.json`) does **not**
have to change for the baseline — sources surface via a **sidecar file**, and
on-screen stat citations are an opt-in stretch that touches only the `stat` template.

**Approved scope for the spine (3.1):** retrieval-grounded generation (**strict** —
cite only what the snippets support) + a `sources.json` sidecar. Auto-picked
**grounded** hooks follow in 3.2. A **default-on** verify pass and **opt-in**
on-screen stat citations are gated at 3.3.

---

## 1. Goal — two pillars

- **Hooks:** the opening beat is the single biggest driver of whether a short gets
  watched. Generate several candidates against proven patterns (curiosity gap,
  surprising stat, bold/counterintuitive claim, direct question), then select the
  strongest → it becomes beat 0. Add retention-aware pacing to the beats prompt.
- **Grounding:** an LLM states confident-but-wrong facts. Ground the script in real,
  retrieved sources and attach a citation per fact. Credible for clients (you can
  hand them the sources) and, because specific real facts are more striking than
  generic ones, **better hook material too.**

The pillars reinforce each other: grounded real facts feed stronger hooks. This is
why grounding is built **before** hooks.

---

## 2. Current architecture — the path as it stands

Orchestrated in [backend/main.py](../../../backend/main.py) (`run()`), strictly
sequential and **headless** (the preview drives it by parsing `PROGRESS {…}` JSON
lines off stdout; human logs go to stderr):

```
topic
  └─ script.generate_script(topic)      → BeatsScript {title, beats[]}     ← the only LLM call
  └─ recipe.plan(script, theme)         → ScenePlan {scenes[PlannedScene]} ← deterministic, no I/O
        ├─ tts.synthesize([b.text])     → LineOffset[]  (one narration span per beat)
        ├─ timing.transcribe_words()    → WordTiming[]  (word-level captions)
        ├─ footage.fetch_footage(reqs)  → Clip[]        (only needs_footage scenes; cached by query hash)
        └─ assemble.build_spec(plan, …) → Spec → validate_spec(spec, catalog) → spec.json
```

### Content contract (model output)

[backend/pipeline/content.py](../../../backend/pipeline/content.py)

| Type | Shape | Notes |
|------|-------|-------|
| `Beat` | `text: str`, `data?: Dict`, `keywords?: str` | `data` is free-form; today `{value, label, icon?}`. `text` is trimmed + non-empty. |
| `BeatsScript` | `title: str`, `beats: List[Beat]` | Non-empty title and beats. |

Parsed/validated by `parse_beats_response()` → Pydantic. The whole point of the
Pydantic layer is **provider-portability**: the guarantee does not depend on a
provider's structured-output mode.

### Generation

[backend/pipeline/script.py](../../../backend/pipeline/script.py)

- One `SYSTEM_PROMPT` string, a **single** `chat.completions.create` pass,
  `temperature=0.8`, `response_format={"type": "json_object"}`.
- DeepSeek via the OpenAI-compatible client (`LLM_PROVIDER` = `deepseek` default |
  `ollama` | `anthropic`). `client=` is **injectable** for tests.
- `_parse_with_retry` → `MAX_RETRIES = 1` (one retry on an invalid reply, then fail
  loudly).
- **No re-architecture needed for grounding** — grounding is prompt-context (inject
  retrieved snippets) plus a retrieval call *before* this pass.

### Recipe / director (deterministic)

[backend/pipeline/recipe.py](../../../backend/pipeline/recipe.py)

- **Position wins:** beat `0` → `hook`, last → `outro`, middle → `stat` (iff `data`
  has **both** `value` and `label`) else footage `scene`.
- The model **never** names a `kind`. Composition is the recipe's job.
- `_stat_props(beat)` builds `{value, label, icon?}` — **the single chokepoint** a
  `source` would pass through to reach an on-screen stat.
- Transitions are selective by default (emphasis only); the plan emits intent, and
  `assemble` resolves duration.

### Assemble → validate → spec

[backend/pipeline/assemble.py](../../../backend/pipeline/assemble.py) ·
[backend/pipeline/validate.py](../../../backend/pipeline/validate.py) ·
[backend/schema.py](../../../backend/schema.py)

- `build_spec` binds the plan to audio timing + footage, emitting a schema-valid
  `Spec`. For non-footage scenes it passes `dict(ps.props)` **straight through** to
  `Scene.templateProps`.
- `validate_spec` checks every scene's `templateProps` against its template's
  manifest `inputSchema` (JSON Schema) via `jsonschema`, fail-fast before writing.

---

## 3. The "source ride-through" path (central to §5.2)

How a per-beat `source` would reach each surface:

**On-screen (stat only):**
```
Beat.source
  → recipe._stat_props()      (must attach it)
  → PlannedScene.props
  → assemble.build_spec()      (already passes props through untouched ✅)
  → Scene.templateProps
  → validate_spec()            (stat inputSchema MUST allow `source` — see constraint #1)
  → spec.json
  → Remotion stat Component    (renders a small citation line)
```

**Sidecar / description list (all factual beats):**
```
Beat.source  (lives on the BeatsScript that main.run already holds)
  → sources.json written next to spec.json   ← needs NO threading through recipe/assemble
```

> **Key insight:** `assemble` already forwards props untouched, so the only real
> gates for on-screen are the **recipe** (to attach `source`) and the **stat
> inputSchema** (to allow it). The sidecar path is even simpler — `main.run` already
> has the full `BeatsScript`, so the description list needs no plumbing at all.

---

## 4. Constraints the code imposes

1. **`.strict()` stat schema → on-screen citation is not free.**
   [templates/stat/schema.ts](../../../templates/stat/schema.ts) is `.strict()`, so
   [templates/stat/manifest.json](../../../templates/stat/manifest.json) has
   `additionalProperties: false`. An unknown `source` prop would be **rejected** by
   `validate_spec`. On-screen citation therefore requires: edit `stat/schema.ts`
   (add `source?`), **re-run the codegen**
   ([templates/scripts/gen-manifests.ts](../../../templates/scripts/gen-manifests.ts) —
   `manifest.json` is *generated*, never hand-edited), then the validator passes and
   the Component can render it.

2. **The Spec contract is mirrored in two files.**
   [backend/schema.py](../../../backend/schema.py) ⇄ `remotion/src/schema.ts` must
   stay byte-for-byte identical in shape. So a **sidecar `sources.json` is strongly
   preferred** over a top-level Spec field for the description list — it surfaces
   sources with **zero render-contract churn**.

3. **Non-stat factual beats have no on-screen text card.** A `scene`-kind beat shows
   footage + captions only. A `source` on a scene can live backend/sidecar but has
   nowhere to render visually. On-screen citation ⇒ **stats only**.

4. **The pipeline is headless.** `main.py` is CLI; the preview consumes `PROGRESS`
   lines. Hook selection must run **auto / non-interactive** in this path. Any
   human-pick UI is preview-layer work, outside the clean spine.

5. **Test seam is dependency-injection.** `generate_script(client=…)` and
   `fetch_footage(search=…, downloader=…)` let tests inject fakes. The Tavily seam
   must mirror this → fully TDD-able offline.

6. **Cache pattern to mirror.** Footage caches by `sha1(query)[:8]` + a sidecar
   file. Retrieval caching should copy this: one `<hash>.json` per query.

7. **Deps / env.** `requests` is already a dependency; **`tavily` is not installed**.
   `.env` has `DEEPSEEK_*` and `PEXELS_API_KEY` but **no `TAVILY_API_KEY` yet**.
   The `LLM_PROVIDER` env + `config.get_env/require_env` is the seam to imitate.
   Per the prompt's §9, **ask before adding any dependency beyond Tavily** (e.g. a
   second model for a verify pass).

---

## 5. Open decisions — rulings & recommendations

| # | Decision | Options | **Recommendation** |
|---|----------|---------|--------------------|
| 5.1 | **Grounding depth** | retrieval-grounded / verify-only / both | **Retrieval-grounded now**; lightweight self-verify deferred to 3.3 as opt-in (same DeepSeek, no new model). |
| 5.2 | **Source surfacing** | internal-only / sidecar list / on-screen on stats | **Per-beat `source` + `sources.json` sidecar** (the description list). On-screen stat citation = opt-in stretch in 3.3. |
| 5.3 | **Hook selection** | auto-pick / human-in-the-loop / both | **Auto-rank-and-pick**, but **retain candidates + scores** in output so a future preview override is cheap. |
| 5.4 | **Cost bound** | (define) | **Baseline ≤ 1 Tavily + ≤ 2 LLM** per video; **with verify ≤ 4 Tavily + ≤ 3 LLM**. All retrieval cached. *(Confirm.)* |

### 5.1 — Grounding depth
Retrieval-grounding is the spine and is strongest for clients. The verify pass is
valuable but doubles LLM passes and may tempt a second model — so make it a
**bounded self-check against the already-retrieved snippets** using the same
DeepSeek, added only if wanted at the 3.3 gate.

### 5.2 — Source surfacing
Adopt the lean: capture `source` per factual beat (backend) and write a
`sources.json` sidecar (full client credibility, **no render-contract risk** — see
constraint #2). On-screen-on-stats is the strongest visual signal but is the only
path that touches `schema.ts` + codegen + Component layout + a re-render check, so it
earns its own opt-in gate.

### 5.3 — Hook selection
Auto-pick keeps the spine headless/scalable. Surfacing the candidates + scores (in
the return value / sidecar) makes "override in preview" cheap later — effectively
"auto-pick with override" minus building the UI now. The interactive picker is
deferred preview work unless you ask for it.

### 5.4 — Cost bound (proposed ceiling — please confirm)
- **1 Tavily search** for the topic, cached by query.
- **1–2 LLM passes:** try to *fold* hook-candidate-generation + grounded beats into
  one pass; a 2nd pass only if selection wants isolating.
- **Optional verify (3.3):** **≤ 1 batched LLM pass** and **0 extra Tavily by
  default** (re-uses retrieved snippets; only a claim with *no* supporting snippet
  triggers a targeted lookup, capped at ≤ 3).

---

## 6. Tavily retrieval seam — design notes

- **Verify against live docs first** (prompt §3): exact endpoint, params, auth
  header, pricing/tier — do **not** assume. This happens at the start of 3.1.
- **Lean: a thin `requests`-based seam, no new dependency** (mirrors
  [footage.py](../../../backend/pipeline/footage.py)'s use of `requests`), rather
  than the `tavily-python` SDK — keeps deps minimal and the seam genuinely
  swappable. Final REST-vs-SDK call made after reading the docs.
- **Shape:** a new `backend/pipeline/retrieval.py` exposing something like
  `search(query, *, key=None, search=None) -> RetrievedContext` where `search=` is
  injectable for tests (exactly like `fetch_footage`).
- **Cache:** one `<sha1(query)>.json` per query (mirror the footage cache), so
  re-runs and per-claim checks don't re-fetch.
- **Bounded:** one topic retrieval + (optional) targeted per-claim checks — never
  unbounded.
- **Env:** add `TAVILY_API_KEY` to `.env.example`; read via `config.require_env`.

---

## 7. Schema / data changes (all additive, illustrative — not final code)

- **`Beat`** gains an optional `source` (URL, maybe a short snippet).
  **`BeatsScript`** may gain an optional `sources` list. Pydantic, backend-only.
- **Sidecar:** `sources.json` written next to `spec.json` (title + per-fact
  `{text, source}`), for the description list / client hand-off. **No Spec change.**
- **On-screen (opt-in, 3.3 only):** `stat/schema.ts` gains `source?: string`
  (`.optional()`), codegen re-run, `stat` Component renders a small citation line,
  `recipe._stat_props` attaches it. This is the **only** change that reaches the
  render spec.

Everything stays additive/optional so nothing in the working pipeline breaks.

---

## 8. Sub-step plan + gates

Order: **grounding before hooks** (grounded real facts give the hook step richer
material). Two hard stops, as the prompt requires.

### 3.1 — Grounding spine ⟶ **STOP for review**  ← *building now*
- Verify Tavily API via **live docs** (endpoint / auth / params); add `TAVILY_API_KEY` to `.env.example`.
- `pipeline/retrieval.py`: thin **`requests`-based** Tavily seam + hash-by-query JSON cache. TDD with a fake search fn (DI like `footage.py`).
- `Beat` gains optional `source` (+ optional `BeatsScript.sources`), additive. TDD in `test_content.py`.
- **Strict** grounded `generate_script`: retrieve topic context, inject snippets + URLs, and instruct the model to (a) state **only** what the snippets support, (b) cite the **specific** snippet/URL per factual beat, (c) mark a beat ungrounded / drop it when nothing supports it. Still `parse_beats_response` + retry-once. TDD with fake client + fake retrieval.
- `sources.json` **sidecar** written from the `BeatsScript` in `main.run` (the client description list — part of the spine per Q2). TDD where practical.
- **Gate:** a topic → grounded `BeatsScript` whose factual beats carry a *trustworthy* source URL from the retrieved set, plus a `sources.json` sidecar. No render-contract changes.

### 3.2 — Hooks (grounded)
- Generate N hook candidates across proven patterns (curiosity gap / surprising stat / bold claim / direct question), **drawn from the grounded facts** — the most striking *true* fact framed punchily, **never invented** — then auto-select → beat 0. Retain candidates + scores. Retention-aware pacing in the prompt. TDD.
- **Gate:** the opening hook is deliberately generated/selected from grounded material; candidates inspectable.

### 3.3 — Verify + on-screen surfacing ⟶ **STOP at E2E checkpoint**
- **Verify pass (default-on for client output, skippable for reach-only):** one batched self-check (same DeepSeek) of each claim against its already-retrieved snippet — **zero extra Tavily** by default; flag / correct / drop unsupported claims.
- *(opt-in)* on-screen stat citation: `stat/schema.ts` += `source?`, re-run gen-manifests, Component renders it, `_stat_props` passes it; re-render check.
- **Gate (E2E):** a real video from a topic with a strong hook **and** grounded, *verified*, sourced facts; sources surfaced per §5.2; full pipeline green; changes additive.

---

## 9. Constraints to honor (from the prompt §6)

- Keep **DeepSeek** as the LLM provider; extend, don't replace.
- Keep Phase 2's **deterministic split**: the model produces content (+ now
  sources); the **recipe still owns composition**. The model never asserts a
  template / kind.
- Don't break the working script → recipe → footage → assemble path; all changes
  additive.
- **Provider-agnostic Pydantic validation stays** — no provider-specific
  structured-output modes.
- **Bound** Tavily + LLM passes; **cache** retrieval.

---

## 10. Definition of done

- A topic produces a script whose factual claims are grounded in retrieved sources,
  each fact carrying a citation.
- The opening hook is deliberately generated/selected, not incidental.
- Sources surface per the §5.2 decision (a sidecar description list at minimum).
- The full pipeline still runs E2E; provider stays DeepSeek; changes additive.
- Validation green; the new content shapes (grounded beats, sources, hook selection)
  are TDD'd.

---

## 11. Not this phase

Platform/scale (batch, cloud render, more recipes), new template types,
multi-platform / aspect-ratio output, and the two Phase-2 polish items (hook
subtitle, single-digit stat scaling) — unless one is trivially adjacent.

---

## 12. Open questions awaiting "go"

1. **§5.4 cost ceiling** — OK to lock **baseline ≤ 1 Tavily + ≤ 2 LLM**, **with
   verify ≤ 4 Tavily + ≤ 3 LLM**, all retrieval cached?
2. **Spine scope** — confirm **auto-pick hooks + `sources.json` sidecar** is the
   spine, with **on-screen stat citation and the verify pass deferred to opt-ins at
   3.3**.
3. **Tavily client** — any preference for the official `tavily-python` SDK vs a thin
   `requests` seam? (My lean: `requests`, no new dep — final call after reading the
   docs.)

---

## Appendix — file reference

| Area | File | Role in this phase |
|------|------|--------------------|
| Orchestrator | [backend/main.py](../../../backend/main.py) | Sequential `run()`; holds the `BeatsScript` → easiest place to write the sidecar. |
| Generation | [backend/pipeline/script.py](../../../backend/pipeline/script.py) | DeepSeek pass; gets retrieved context injected + hook candidate/select. |
| Content contract | [backend/pipeline/content.py](../../../backend/pipeline/content.py) | `Beat` / `BeatsScript` gain optional `source` / `sources`. |
| Recipe | [backend/pipeline/recipe.py](../../../backend/pipeline/recipe.py) | `_stat_props` is the chokepoint to attach `source` for on-screen. |
| Assemble | [backend/pipeline/assemble.py](../../../backend/pipeline/assemble.py) | Already passes props through untouched. |
| Validate | [backend/pipeline/validate.py](../../../backend/pipeline/validate.py) | Checks props vs manifest `inputSchema`. |
| Spec models | [backend/schema.py](../../../backend/schema.py) | Mirrored in `remotion/src/schema.ts` — avoid touching ⇒ sidecar. |
| Footage (pattern) | [backend/pipeline/footage.py](../../../backend/pipeline/footage.py) | Cache + DI seam pattern to mirror for retrieval. |
| Config | [backend/pipeline/config.py](../../../backend/pipeline/config.py) | `get_env` / `require_env` for `TAVILY_API_KEY`. |
| Stat zod | [templates/stat/schema.ts](../../../templates/stat/schema.ts) | `.strict()`; add `source?` for on-screen (opt-in). |
| Stat component | [templates/stat/Component.tsx](../../../templates/stat/Component.tsx) | Renders the optional citation line (opt-in). |
| Stat manifest | [templates/stat/manifest.json](../../../templates/stat/manifest.json) | **Generated** — re-run codegen, don't hand-edit. |
| Codegen | [templates/scripts/gen-manifests.ts](../../../templates/scripts/gen-manifests.ts) | zod → `inputSchema`; must re-run after a schema edit. |
| Tests (pattern) | [backend/tests/test_script.py](../../../backend/tests/test_script.py) · [test_content.py](../../../backend/tests/test_content.py) | DI fake-client / shape tests to mirror for TDD. |
| New (3.1) | `backend/pipeline/retrieval.py` | Thin Tavily seam + cache (to be created). |
| New (3.3) | `sources.json` (sidecar) | Description list / client hand-off (to be created). |

## Post-review caption-layer fix (frame review)

The two committed key frames surfaced a caption-layer issue independent of the
grounding work. Root cause: the karaoke caption layer is **global** (root-level in
[Video.tsx](../../../remotion/src/Video.tsx), fed by a flat `spec.captions`), so it
rendered the spoken words over the full-text hero cards (hook/stat/outro) that
already display that text — duplicating it. The 3.2 "hook is the hero" change
*promoted* the hook duplication (the hero is now `beat.text`, exactly what the
caption shows); the stat/outro duplication, the `,700` number fragment, and the
gigatonnes/gigatons mismatch were all pre-existing.

Shipped in this PR (TDD; audio-sync math `seqDurᵢ = dᵢ + Tᵢ` and spec contract
untouched):

1. **Caption suppression over hero cards.** New optional `rendersOwnText` manifest
   envelope flag (hand-authored alongside `kind`/`durationFrames`, NOT derived from
   zod, so `gen-manifests` preserves it; mirrored in
   [sdk.ts](../../../templates/sdk.ts) `Manifest` + [manifest.py](../../../backend/manifest.py),
   set `true` on hook/stat/outro). The renderer builds `[start,end)` suppress spans
   from scenes whose template declares it and hides the caption there
   ([Captions.tsx](../../../remotion/src/Captions.tsx)); captions still play over
   footage. Core hardcodes no template id — the policy rides the manifest flag.
2. **Number-atomic captions.** [timing.py](../../../backend/pipeline/timing.py) now
   re-glues a numeric tail (`"37"` + `",700"` → `"37,700"`) so the karaoke never
   shows a leading-comma fragment.

### Deferred follow-up (non-blocking, tracked here)

3. **stat `label` ↔ spoken `beat.text` wording.** The LLM emits `data.label`
   ("gigatonnes …") and the narration `beat.text` ("gigatons …") as independent
   strings, so the viewer can *hear* one spelling and *read* another. Suppressing
   the caption removes the on-screen conflict but NOT this audio↔screen mismatch.
   Planned fix: a system-prompt rule that `data.label` reuse the spoken wording
   ([script.py](../../../backend/pipeline/script.py) `SYSTEM_PROMPT`); ruled
   non-blocking for the Phase-3 merge.
