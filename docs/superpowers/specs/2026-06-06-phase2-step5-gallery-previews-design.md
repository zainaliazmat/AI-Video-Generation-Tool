# Phase 2 — Step 5: Templates Gallery + Auto-Rendered Previews — Design

**Date:** 2026-06-06
**Status:** APPROVED 2026-06-06 — layout = **hybrid (showcase grid + detail drawer)**; mechanism
per recommendations (TemplatePreview composition, gen-previews script + CI freshness +
graceful-missing, two labelled placeholder cards for transition previews). Build 5.1→5.3; stop
for review after 5.1 and 5.3. **5.1 DONE** (TemplatePreview composition; render + transition
kinds verified by stills; remotion typecheck green).
**Spec authority:** `claude-code-template-plugin-phase-prompt.md` §5 (previews), §9 step 5;
locked decision #4 (previews = short looping MP4 ~1.5s + poster still, auto-rendered from
sampleProps).
**Prereqs:** Step 6 complete (recipe/director, validation, zod bridge). The registry
(`templates/registry.generated.ts`) exposes every template's `{type, manifest, component|presentation}`.

## Goal

The management/showcase surface over the template library: a gallery in the preview app
that lists every discovered template with a **looping preview auto-rendered from its
`sampleProps`**, its kind, duration range, and props — so a template that's dropped into
`templates/` shows up here with zero manual upkeep (the WordPress-plugin-directory feel).

## What we already have to build on
- **Preview app** (Next.js App Router): single `Studio` page (`/`), `@remotion/player`
  via `VideoPlayer` (`<Player component={Video} inputProps={{spec}} .../>`), glass/tailwind
  aesthetic + UI kit (`Eyebrow`, `Badge` with per-tone colors, `Button`), framer-motion,
  sonner. Assets served from `preview/public/` (mirrored by `copy-assets.mjs`).
- **Server-render precedent**: `/api/render` spawns `npm run render` in `remotion/` and
  streams progress over SSE. The same "spawn remotion in a child process" pattern works for
  preview generation.
- **Registry** is imported by `Video.tsx`; a server component can import it the same way to
  enumerate templates (id, name, kind, sampleProps, durationFrames, inputSchema).

---

## Part A — Preview generation (auto from `sampleProps`)

**The core problem:** render ONE template in isolation from its `sampleProps` — for both
`render`-kind (a `TemplateProps` component) and `transition`-kind (a `<TransitionSeries>`
presentation). The existing `Video` composition takes a whole `Spec` (captions, audio,
multi-scene); too heavy and wrong-shaped for a single-template preview.

**Proposed mechanism — a dedicated `TemplatePreview` Remotion composition** (`remotion/src/`,
registered in the Remotion root), inputProps `{templateId, props, theme, kind}`:
- **render-kind:** resolve `registry[id]`, render `<entry.component data={props} theme={theme}
  timing={{fps, durationInFrames}} assets={{}} />` over the theme background — one scene, no
  captions/audio. (`scene`'s sampleProps points at `assets/clip-1.mp4`, already in public.)
- **transition-kind:** a minimal `<TransitionSeries>` of two labelled placeholder cards
  ("Scene A" → "Scene B") with the transition (built via `entry.presentation(props)`) between
  them, so the motion is actually visible. (Open Q3: placeholder content.)

**Generation script — `remotion/scripts/gen-previews.mjs`** iterates the registry and, per
template, invokes Remotion twice:
- `remotion render TemplatePreview` with `--props='{templateId,props:sampleProps,theme}'` →
  **`preview/public/previews/<id>.mp4`** (~45 frames @ 30fps = 1.5s, loops in the gallery).
- `remotion still TemplatePreview --frame=22` → **`preview/public/previews/<id>.jpg`** (poster).

The gallery plays `<video src="/previews/<id>.mp4" poster="/previews/<id>.jpg" loop muted
autoplay playsinline>`. Missing preview → show the poster, else a "preview pending" placeholder
(graceful, never a hard error).

**Regeneration cadence (Open Q2):** ~14 Chrome-backed invocations (7 templates × mp4+still) is
a couple of CPU-minutes — too slow for every `dev` start. Propose a **`npm run gen-previews`
script run when a template changes / in CI** (NOT wired into the dev/build hot path), plus —
tying to your earlier ask — a **CI check that fails on a stale/missing preview** (same spirit as
the zod-manifest freshness check). Alternative: an on-demand API route that renders+caches a
preview on first request (heavier; defers cost to page load).

---

## Part B — Gallery UI

**Route:** new `preview/app/templates/page.tsx` (server component) imports the registry,
builds the template list, hands it to a client grid. **Nav:** a lightweight top toggle between
**Studio** (`/`, the generate flow) and **Templates** (`/templates`) — minimal, matching the
glass aesthetic (Open Q4).

**Per-card content (Open Q5 — how deep):**
- Looping preview (9:16, poster fallback) — the hero of the card.
- Name + **kind Badge** (color per kind — reuse `Badge` tones: hook=blue, scene=dim,
  stat=green, transition=purple, overlay=amber, outro=red).
- Duration range (`durationFrames.min–max` → "30–120f").
- `sampleProps` (pretty key/values or collapsible JSON).
- Optional **props table** from `inputSchema` (field · type · required) — genuinely useful as
  living docs for template authors (the zod→JSON-Schema bridge now makes this accurate).
- Footer: `author` · `v{version}` · `apiVersion`.

**Interactions:** responsive card grid (2–3 cols); **filter pills by kind** (using `Badge`);
autoplay-muted-loop (or hover-to-play) previews. Data: server imports `registry` → list;
client handles filter + playback; asset URLs = `/previews/<id>.{mp4,jpg}`.

---

## Sub-step gating (each its own checkpoint)

| # | Scope | Checkpoint |
|---|-------|------------|
| **5.1** | `TemplatePreview` composition (render + transition kinds) + Remotion root registration | In `remotion studio` / a still render, every template renders in isolation from its sampleProps (incl. a visible transition) |
| **5.2** | `gen-previews.mjs` → MP4 + poster per template into `preview/public/previews/` (+ optional CI freshness check) | All 7 previews generated; re-running is idempotent |
| **5.3** | `/templates` route + nav + card grid + kind filter, consuming registry + previews | Gallery shows all 7 with looping previews, filterable; `next build` + typecheck green |

I'd stop for your review after **5.1** (the isolation composition — the foundation) and at
**5.3** (the gallery, the visible deliverable).

---

## Open decisions for your gate
1. **Preview-gen mechanism:** dedicated `TemplatePreview` composition + `gen-previews` script
   (vs. some other isolation approach). Confirm.
2. **Regeneration cadence:** script run on template-change/CI + graceful-missing in the gallery
   (recommended), vs. on-demand-render-and-cache API route. Your call.
3. **Transition preview content:** what the two placeholder cards show ("Scene A/B" labels? two
   real sample cards like hook→stat?). Confirm.
4. **Gallery nav:** separate `/templates` route + top toggle (recommended) vs. a section on the
   existing Studio page.
5. **Card depth:** include the `inputSchema` props table (living docs) or keep cards minimal
   (preview + name + kind + sampleProps)?
6. **Layout:** see the two sketches I'll present at the gate.

## Testing / verification
The preview app has no unit tests (UI); coverage is `build-registry` + `tsc` + `next build`,
plus visual stills. `gen-previews` is codegen — verified by its output (7 mp4+poster pairs).
`TemplatePreview` verified by a still/render per template. In-browser headless QA is blocked
here (Chromium sandbox / AppArmor), so I'll verify via `next build` + a still render of a
template preview, as in prior phases.

## Not this step
Per-template "open in Studio / try with my data" deep links; a props-form editor (the
inputSchema makes it possible later); search; pagination. Marketplace/install flows (§7, future
phase).
