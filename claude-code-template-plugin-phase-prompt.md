# Phase 2 — Template Plugin System (Build Prompt for Claude Code)

You have full read/write access to this repository. This document tells you **what we want to build next** and **how to work**. Read it fully, then follow §0 before touching any code.

---

## 0. Read first, build later — do this BEFORE writing any code

1. **Read the entire codebase** and build a mental model of:
   - The `spec.json` contract — its current shape (I believe it has `meta`, `audio`, `scenes`, `captions`, `style` — **verify**) and where it's defined on *both* sides (Python Pydantic model + the TypeScript type). Note: these are meant to stay in lockstep.
   - How the Remotion renderer turns a spec into video: the root composition, how `scenes` and `captions` currently render, how assets are referenced (`staticFile`), and how timing works (it should be frames-based).
   - How the LLM provider is wired (`LLM_PROVIDER`). **DeepSeek may already be integrated** — confirm exactly how. We keep DeepSeek as the provider; do not re-architect this.
   - The preview/control app — confirm whether it's Next.js, and whether/how it currently triggers the pipeline or a render.
   - The backend pipeline stages (script → tts → timing → footage → assemble) and how they hand off.

2. **Reply with**, and nothing more (no code yet):
   - (a) A concise map of the current architecture in your own words.
   - (b) Anything in the code that **conflicts with or constrains** the plan below (e.g. the actual spec shape, the real app framework, how the provider is wired).
   - (c) Your clarifying questions — grounded in what you actually found in the code.

3. **Do not write or modify code until I confirm.** Ask questions based on the real codebase, not assumptions. I will answer, then you implement in the §9 order.

---

## 1. What we're building this phase

A **template plugin system**: video templates become self-contained, drop-in plugins — think WordPress plugins. Someone authors a template, drops its folder into a templates directory, and it is **automatically discovered, validated, listed in a gallery in the app, and usable by the renderer — with zero changes to core code.**

This phase also lands the supporting pieces the plugin system needs: a **`theme`** system, a **`layers`/overlays** concept in the spec, and a **composition/recipe** layer that assembles videos from templates.

**Direction that shapes decisions:** this project is heading toward a **business/product**, we will **spend for speed and quality** (DeepSeek for scripts now; cloud-parallel rendering later), and the **polished app matters** (it's a real UI, not CLI-only). Build accordingly — but **do not build the multi-tenant marketplace yet** (see §7).

---

## 2. Core principle — the plugin contract

The insight that makes this work: **a template plugin is one self-contained folder containing a language-neutral manifest plus a Remotion component. The manifest is the shared contract, read by both the Python backend and the renderer. Core never hardcodes any template** — exactly like WordPress never hardcodes a plugin.

Each template folder contains:
- **`manifest.json`** — metadata + the template's input schema. Read by **both** the Python backend (to know the catalog, validate specs, and inform the script step) **and** the renderer (to build its registry).
- **`Component.tsx`** — the Remotion component. Renderer-side only.
- **a preview asset** — auto-generated (see §5).

**Discovery → registry → use:**
- A **discovery step** scans the templates directory, reads every `manifest.json`, and builds a **registry** (`id → { manifest, component }`). Propose the mechanism that fits our build cleanly (e.g. a codegen step that generates a typed registry module) — confirm what works with Next.js + Remotion bundling.
- The renderer resolves `scene.template` (an id) → the registered component.
- The app reads the same registry to render the **Templates gallery** (its own section), one card per template with preview + metadata.

**Example `manifest.json`:**
```json
{
  "id": "stat-callout",
  "name": "Stat Callout",
  "version": "1.0.0",
  "author": "you",
  "apiVersion": "1",
  "kind": "stat",
  "inputSchema": { "...": "JSON Schema for { value: string, label: string, icon?: string }" },
  "sampleProps": { "value": "90%", "label": "of the ocean is unexplored", "icon": "wave" },
  "durationFrames": { "min": 45, "max": 120 }
}
```

**The `TemplateProps` SDK** — every template component receives a stable props object:
```ts
interface TemplateProps<Data> {
  data: Data;             // validated against the template's inputSchema
  theme: Theme;           // resolved palette, fonts, transition style, caption style
  timing: { fps: number; durationInFrames: number };
  assets: ResolvedAssets;  // staticFile-resolved paths for any media the template needs
}
```
Templates **must** style from `theme` tokens only (no hardcoded colors or fonts). This is what lets one template produce many looks. Use `useCurrentFrame()` for animation within `durationInFrames`.

**The input-schema bridge:** author the schema once as **zod** in the template (TS), and export it to **JSON Schema** into the manifest for Python. This single schema powers three things at once: (1) the script step knows what data to produce, (2) specs are validated before rendering (fail fast at volume), (3) the app can auto-generate a props form for manual tweaking later.

---

## 3. Slots / template kinds

Templates are not interchangeable; each declares a `kind` (slot). **Proposed set — confirm or adjust against the codebase:**

`hook`, `scene`, `stat`, `lower-third`, `transition`, `overlay`, `outro`

The spec references templates by the slot appropriate to each position (a `transition` cannot go where a `scene` goes). Enforce this in validation.

---

## 4. spec.json additions

Extend the contract on **both** the Pydantic model and the TS type, kept in lockstep:
- Each **scene** gains `template` (id) + `templateProps` (validated against that template's input schema).
- An optional **`transition`** between scenes (references a `transition`-kind template).
- A top-level **`theme`** object (palette, font pairing, transition style, caption style) — **separate** from templates so any template re-themes without code changes.
- A **`layers` / `overlays`** array for things composited on top (`overlay`-kind templates, e.g. Lottie or transparent video). Captions are already a layer — fold them into this model or keep them consistent with it.

Preserve **frames-based timing** throughout, and keep **spec.json as the single source of truth** between backend and renderer. Update `sample-spec.json` to reflect the new shape.

---

## 5. Previews

**Auto-render** each template's preview from its `sampleProps` by running it through Remotion (a script that outputs a short clip or thumbnail per template). No manual preview upkeep — previews regenerate when a template changes. Confirm the format (still image vs short mp4/gif) based on what the gallery needs.

---

## 6. Composition / director layer

Separate **what to say** from **how to compose**:
- **DeepSeek** produces structured *content* (the script broken into beats, with the data each beat carries — e.g. a number for a stat).
- A **deterministic recipe/director** maps that content → a sequence of templated scenes. A recipe for a content type (e.g. `"fact-list"`) decides: `hook` → N `scene`s → a `stat` callout wherever a fact has a number → `outro`, choosing templates by slot and filling their props from the content + theme.

This composition is **deliberately deterministic, not LLM-chosen**, for reliability at volume. The recipe outputs the final `spec.json` the renderer consumes.

---

## 7. Distribution trajectory — build now, design for later

- **Now (build this):** folder-convention plugins in a local `templates/` package, discovered at build time.
- **Design for, but DO NOT build this phase:** the same `manifest` + `TemplateProps` + registry contract must support, **with no rewrite**, (a) templates as installable **npm packages**, and (b) eventually a **runtime marketplace** where templates install per user/tenant. Keep the contract stable and the loader swappable.
- **Explicitly out of scope this phase:** npm-package distribution, runtime/dynamic template loading, third-party template sandboxing, multi-tenant install.

---

## 8. Constraints to honor

- Keep **DeepSeek** as the LLM provider; confirm/extend the provider layer, don't replace it.
- **Don't break the existing render path** — migrate it into the plugin model rather than replacing it.
- **Never hardcode any template into core**; everything resolves through the registry.
- Preserve the existing hard constraints you find (Remotion version alignment across all `@remotion/*` packages, frames-based timing, asset access via `staticFile`, etc.).
- **Licensing awareness** (notes only, not code): Remotion requires a paid Company License for a business past their small-team threshold, and any music/stock assets must be commercially licensed. **Flag these in your report; do not try to resolve them.**

---

## 9. Implementation order (only after I approve your §0 report)

1. **Contract first:** extend `spec.json` (`theme`, `layers`, `scene.template`/`templateProps`, `transition`) on both Pydantic + TS, and define the **manifest schema** and the **`TemplateProps` SDK**. Update `sample-spec.json`.
2. **Registry + discovery:** scan templates, build the typed registry, wire the renderer to resolve templates by id.
3. **Migrate the existing scene + captions rendering into the FIRST template plugin** (the workhorse `scene` template), and get **one video rendering end-to-end** through the new path. **Pause here for a checkpoint** before adding more.
4. Add the remaining core templates as plugins (`hook`, `stat`, `transition`, `overlay`, `outro`), each theme-driven.
5. **Templates gallery** section in the app, reading the registry, with auto-rendered previews.
6. The **recipe/director** composition layer + spec validation against template schemas.

---

## 10. Definition of done

- A template is added by **dropping a folder** into `templates/` — no core edits — and it appears in the gallery, validates, and renders.
- The existing video still renders, now via the plugin path.
- Changing `theme` restyles **all** templates without touching template code.
- A recipe turns DeepSeek content into a valid, rendered `spec.json`.
- `spec.json` remains the single contract; Pydantic and TS definitions match.
- A short **`TEMPLATE_AUTHORING.md`** documents how to author a new template.

---

## 11. How to work

Report your §0 findings and questions first, and **wait for my go-ahead**. Then implement in the §9 order, **pausing after step 3** (one template rendering end-to-end) for a checkpoint before expanding. **Ask before introducing any new dependency.**
