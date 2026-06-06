# Phase 3 — Script v2: Stronger Hooks + Factual Grounding (Build Prompt for Claude Code)

You have full read/write access to this repo. Phase 2 (the template plugin system) is complete and committed. This phase upgrades the **script / content layer** so videos both (a) **hook harder** for reach and (b) state facts that are **grounded and sourced** for credibility and client work. Read §0 before writing any code.

This is a **quality** phase, not a scale one. The platform work (batch, cloud render, more recipes) remains a separate later phase — don't pull it in here.

---

## 0. Read first, build later

1. Read the current script/content layer: `backend/pipeline/script.py` (DeepSeek beats generation, `LLM_PROVIDER`), `backend/pipeline/content.py` (`Beat`/`BeatsScript` + `parse_beats_response`), and how `main.py` calls them. DeepSeek stays the provider via the OpenAI-compatible client — confirm how, don't re-architect it.
2. Confirm: the current `BeatsScript` shape and the retry-once validation, and trace how beats flow into recipe → footage → assemble (if we surface citations, a per-beat `source` may need to ride through to the render — check that path).
3. Reply with, and nothing more (no code yet): (a) a map of the current script → content → recipe path; (b) anything in the code that constrains the plan below; (c) your rulings-or-recommendations on the **Open Decisions (§5)**; (d) a proposed sub-step breakdown + gates. Wait for my go.

---

## 1. Goal — two pillars, both in the script/content layer

- **Hooks (reach):** the opening beat is the single biggest driver of whether a short gets watched. Make it strong and *deliberate*, not a side effect of one generation pass.
- **Grounding (clients + credibility):** an LLM states confident-but-wrong facts. Ground the script in real, retrieved sources and attach a citation per fact — credible for clients (you can hand them the sources), and, because real specific facts are more striking than generic ones, **better hook material too**.

The pillars reinforce each other: grounded real facts feed stronger hooks.

---

## 2. Pillar A — Hooks

- Generate **several hook candidates** for the topic against proven patterns (curiosity gap, surprising stat, bold/counterintuitive claim, direct question), then **select** the strongest; the winner becomes beat 0.
- Retention-aware pacing in the beats prompt (tight opening, a payoff, no dead air).
- Provider stays DeepSeek; this is prompt work plus a candidate-generate-and-select step.

---

## 3. Pillar B — Grounding (via Tavily)

The user has a **Tavily** API key — it's the right tool: a search API built for LLM grounding that returns clean results **with source URLs** (exactly what citations need). **Verify Tavily's current API/usage against its docs** (don't assume endpoint/param/pricing details). Wrap it behind a **thin retrieval seam** so it's swappable later, mirroring the pluggable LLM provider — but no full provider system is needed; Tavily is the concrete default.

Flow (retrieval-grounded — see §5 for depth):
- Tavily-search the topic → gather sourced facts/snippets with URLs.
- DeepSeek generates beats **grounded in that retrieved material**, attaching the supporting `source` (URL) per factual beat — especially stats.
- Optional **verify pass**: re-check each claim against its source, flag/correct unsupported ones.
- **Cache** Tavily results by query (like the footage cache) and **bound** the calls (one topic retrieval + targeted per-claim checks, not unbounded). Cost/latency awareness — fits the spend-for-quality stance, but keep it bounded.

---

## 4. Schema / data changes (all additive)

- `Beat` gains an optional `source` (URL, maybe a snippet); `BeatsScript` may gain a `sources` list. Backend-layer (Pydantic) change.
- **If sources surface on-screen** (a citation under a stat), the `stat` template's zod `inputSchema` + component gain an optional `source`/`citation` field — so the **source-surfacing decision (§5) determines whether this reaches the render spec or stays backend-only**.
- Keep everything additive/optional so nothing in the working pipeline breaks.

---

## 5. Open decisions for your gate (rule before building)

1. **Grounding depth:** retrieval-grounded generation (facts sourced from Tavily first — *my lean*, strongest for clients), a lighter verify-pass-only, or both.
2. **Source surfacing:** internal/QA only, a "Sources" list in the video description/sidecar (easy, strong credibility), or on-screen citations on stats (strongest signal, touches the stat template). *My lean:* capture per-beat sources + a description sources list at minimum; on-screen on stats optional.
3. **Hook selection:** auto-rank-and-pick (scalable), surface candidates for the user to choose (human-in-the-loop), or both (auto-pick with override).
4. **Cost bound:** how many Tavily calls / LLM passes per video is acceptable, and confirm caching.

---

## 6. Constraints to honor

- Keep **DeepSeek** as the LLM provider; extend, don't replace.
- **Keep Phase 2's deterministic split:** the model produces content (+ now sources); the **recipe still owns composition**. The model still never asserts a template/kind.
- Don't break the working script → recipe → footage → assemble path; all changes additive.
- **Provider-agnostic validation (Pydantic) stays** — don't lean on provider-specific structured-output modes.
- Bound Tavily + LLM passes; cache retrieval.

---

## 7. Sub-step gating (each a checkpoint)

Propose the breakdown in §0; a likely shape (suggested order: **grounding before hooks**, since grounded real facts give the hook step richer material):
- **3.1** Tavily retrieval seam + retrieval-grounded generation + per-beat `source` (the grounding spine).
- **3.2** Hook candidate-generation + selection (reach).
- **3.3** (if chosen) verify pass + source surfacing + schema.

Stop for my review after the **grounding spine** and again at the **E2E checkpoint** — a real video generated from a topic with a strong hook *and* grounded, sourced facts.

---

## 8. Definition of done

- A topic produces a script whose factual claims are grounded in retrieved sources, each fact carrying a citation.
- The opening hook is deliberately generated/selected, not incidental.
- Sources surface per the §5 decision (a description list at minimum).
- The full pipeline still runs E2E; provider stays DeepSeek; changes additive.
- Validation green; the new content shapes (grounded beats, sources, hook selection) are TDD'd.

---

## 9. How to work

Report your §0 findings + §5 rulings-or-recommendations + sub-step plan first, and wait for my go. Then build sub-gated, pausing at the grounding spine and the E2E checkpoint. Ask before adding any dependency beyond Tavily (e.g. if a verify pass wants a second model).

---

## Not this phase

Platform/scale (batch, cloud render, more recipes), new template types, multi-platform/aspect-ratio output, and the two Phase-2 polish items (hook subtitle, single-digit stat scaling) — unless one is trivially adjacent to the work above.
