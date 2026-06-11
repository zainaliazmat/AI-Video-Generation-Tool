# Enumeration Visual — Tier 2: Image-as-hero + lucide icons + curated NASA PD set

**Date:** 2026-06-08
**Branch:** `enumeration-visual-tier2` (cuts off `development` AFTER the Tier-1 punch-up merges; this doc is its first commit)
**Status:** design approved, awaiting spec review → plan
**Predecessors:** Tier 1 (motion + layout, merged via the punch-up) · Round 3 (voice-locked reveal mechanism, signed off)

## 1. Goal & the accepted risk

Replace the emoji floor with a designed look that carries real "wow": each item's beat is presented as a **hero image** (curated NASA public-domain photography), with **lucide** line-icons as the coherent fallback. The operator chose the **image-as-hero (max wow)** treatment over the modest icon-size slot, explicitly accepting its risk: a dominant hero can muddy the clean one-by-one enumeration reading that Round 3 proved.

**The design mitigates that risk by construction**, not by restraint: a persistent **running list** keeps the complete 1·2·3 count legible while the hero delivers the wow. Whether the *balance* actually reads as both-wow-and-legible is a pixel verdict at the gate, not a doc claim.

## 2. Frozen plumbing (does NOT move)

Tier 2 is paint over merged plumbing. These are untouched and their regressions stay green throughout:

- Voice-lock: `itemTimings → starts/ends`, onset-synced reveal (the mechanism Round 3 signed off).
- Punch-up entrance: `itemRevealState` (0.65 start → ~1.07 overshoot → settle, 40px rise, 6% accent pop).
- Caption suppression (`rendersOwnText: true`).
- Recipe routing, `TemplateProps.itemTimings`, schema.
- `enumerationSizing` auto-fit shape (monotonic, no-overflow) — but see §6 shaping #1: it is now fed the **list-band** height, not the full frame.

Only `templates/enumeration/Component.tsx` + new pure modules + the bundled asset set change.

## 3. Layout — two zones

Portrait 1080×1920, split into:

- **Hero zone** — top band (a single `HERO_BAND_FRACTION` constant = 0.58, gate-tunable; see §9). Renders the **currently active** item's media at presence.
- **Running list** — the **remainder** band (`1 − HERO_BAND_FRACTION`, minus vertical padding). Renders **every revealed item**, the active row emphasized. The band height comes from ONE exported helper (`listBandHeight()`) read by both the Component and the sizing test, so they never diverge.

```
 .-----------------------.
 |     ( big moon )      |   HERO: active item's NASA image,
 |                       |   ~640px rounded frame, ring/glow on black
 '-----------------------'
         Moon                 big label, accent-tinted while active
 - - - - - - - - - - - - -
   • Sun                      RUNNING LIST: every revealed item;
   ▸ Moon   (active)          active row emphasized (accent tint +
   • Planets                  weight). Preserves the complete count.
```

**Running list contents (decision A):** the list shows **every revealed item**, with the active one emphasized — NOT only already-covered items. Rationale: the list's whole job is to preserve the complete count; if the current item lived only in the hero, the viewer would never see all five enumerated together (the last item would sit only in the hero). The active item appearing in both zones is a "you are here" progress cue tying the hero to its slot, not clutter.

## 4. Active item & hero crossfade

At any frame the **active index** is the largest `i` with `starts[i] ≤ frame` (the last item revealed). The hero shows that item.

When the next item is spoken, the outgoing hero **crossfades out** as the incoming hero **punches in** (reusing the Tier-1 overshoot). This is driven by a pure `heroPresence(frame, i, starts)` so the Component never decides motion inline.

**Shaping #3 — bounded crossfade (fail-safe):** the crossfade (out + punch-in) MUST complete within the **tightest item gap**. The test beat has ~0.67s (~20-frame) gaps (sun→moon→planets), so the crossfade window is bounded to `min(ENTER, gap)` and `heroPresence` MUST guarantee **at most one hero at full opacity** even when items stack tightly. This is asserted in the unit test against a tight-gap `starts` array, and stressed on the clip's close beats. Same fail-closed instinct as the voice-lock fallback.

## 5. The cascade — `resolveMedia(label)`

A new source-swappable resolver, the single decision point for what a beat shows. Reuses the plural-folding `candidates()` helper from `icons.ts`.

```ts
type MediaResolution =
  | { kind: 'image'; src: string; alt: string }  // bundled NASA PD image
  | { kind: 'icon'; name: LucideName }            // lucide line icon
  | { kind: 'mark' };                             // neutral floor
```

Cascade order: **curated image → designed icon → neutral mark**.

- **Image source** = a `label → file` manifest over the bundled NASA set. Implicit curated-set-hit: a label that resolves to a bundled image uses it; no script change, no domain tag (consistent with the Round-3 template-curated ruling — the model still emits labels only).
- **Icon source** = a `label → lucide-name` map (replaces the emoji `CURATED` table).
- Both sources are swappable behind `resolveMedia`, so vendoring an icon subset later (or swapping the image source) stays a localized change.

**Per-zone rendering of the resolution:**

| resolution | hero zone | list zone |
|---|---|---|
| `image` | the image, big (~640px) | a **small icon** (icon-map lookup for that label), not the image |
| `icon` | the lucide icon, large + tinted | the lucide icon, small |
| `mark` | the neutral mark, large | the neutral mark, small |

The hero never renders the big image in the list; the list is always icon/mark-scale. So a celestial list is full-image heroes + an icon-marked count; an odd non-celestial label degrades to a large lucide hero without breaking the layout.

**Checked invariant — every image-label has an icon (`imageManifest.keys ⊆ iconMap.keys`):** because an image-item's *list* row renders a small icon (not a thumbnail), any label with a NASA image but no icon-map entry would fall image→icon→**mark** in the list — a moon image in the hero with a blank dot in the list row beneath it. That inconsistency is turned from a curation hope into a checked invariant: every key in the image manifest MUST have a key in the icon-map, asserted in `media.test`. Same move as the CREDITS gate — "don't forget" becomes "can't ship without."

**List-row entrance (conscious choice, gate-tunable):** a newly-revealed list row uses a **subtler appear** (fade + small rise, NO overshoot) — the hero owns the big punch, and a secondary-zone row popping with the same overshoot would fight it. This is a deliberate default, not an accident; it is a gate-tunable like the 58/38 split.

**Shaping #2 — hero crop/fit for mixed-aspect images:** NASA shots vary in aspect ratio. The hero frame is a **fixed ~640px rounded box** with `object-fit: cover`, subject-centered. Fixed crop + centered-subject curation together make a varied source set read as one coherent set. (Curation note, operator-owned: pick shots where the body reads clearly when cropped to a centered square on black.)

## 6. Auto-fit, re-pointed (shaping #1)

`enumerationSizing` was built to fill the **whole** frame. The running list now lives in the remainder band (`1 − HERO_BAND_FRACTION`, minus padding), so it is fed that **band height** via the shared `listBandHeight()` helper — not the full frame height — so six small rows fit the band without bleeding up into the hero. Critically, the Component's sizing call and the sizing test both read `listBandHeight()`, so the test guards the exact band the Component renders (no silent 38-vs-42 drift). The hero's own sizing (image box, label) is separate and keyed to the hero band. The 6-item gate clip is exactly what catches a list that overflows its band.

## 7. New / changed modules

- `templates/enumeration/media.ts` — `resolveMedia(label): MediaResolution` + the image manifest + the lucide name map, plus `iconNameFor(label): LucideName | null` (icon-layer-only resolve for image-item list rows, statically imported by the Component — no runtime `require`) and `toPascal` (kebab→PascalCase, shared with the lucide-registry test). Pure, deterministic.
- `templates/enumeration/heroState.ts` — `activeIndex(frame, starts)` and `heroPresence(frame, i, starts)`. Pure. (The Component uses `heroPresence` ALONE for hero opacity — a single fade ramp — and `itemRevealState` only for the pop+rise, so the entrance is not double-faded.)
- `templates/enumeration/sizing.ts` — gains `HERO_BAND_FRACTION` + `listBandHeight()` (the single band source-of-truth) and `enumerationSizing(itemCount, bandHeight)`.
- `templates/enumeration/LucideGlyph.tsx` — thin wrapper over **lucide-react** (ISC), tinted via `color`, sized via `size`. The only new npm dependency.
- `templates/enumeration/Component.tsx` — rewrite into hero zone + running list, consuming the above. Keeps `useCurrentFrame`, `heroBackground` breathing, theme palette.
- `templates/enumeration/assets/CREDITS.json` — per-asset provenance record (see §8).
- `templates/enumeration/icons.ts` — the emoji `CURATED` table is superseded by the lucide name map in `media.ts`; `candidates()` is reused (export it, or relocate to a shared helper).

## 8. Assets & provenance

- Image files live in `remotion/public/enumeration/` so `<Img staticFile>` resolves them; the `label → file` manifest and `CREDITS.json` live in-folder (`templates/enumeration/`).
- **`CREDITS.json`** holds one record per bundled asset: `{ label, file, source_url, rights, date }`.
- **CREDITS gate (completeness, checked in the COVERAGE direction):** the gate enumerates the **actual image files** in `remotion/public/enumeration/` and FAILS if any one lacks a complete record — so an image dropped in with no record cannot ship green (checking only that *listed* records are filled would leave a no-record file invisible). It verifies the provenance fields are *filled*, NOT that the rights claim is *true*. The truth of each `rights: PD / source: …` line is operator-owned, per asset, confirmed against NASA's authoritative media-usage guidance. The gate guarantees you can't ship one you forgot to vouch for; it does not vouch for you.
- Operator owns curation: source direct from images.nasa.gov / NASA missions (SDO sun, LRO moon+phases, Cassini/Voyager/JPL planets, NASA eclipse photography). Avoid the traps — Hubble/Webb is often ESA CC-BY-SA not PD; skip embedded third-party material and identifiable people; never the NASA insignia.
- **Asset hygiene:** downscale source files to roughly hero resolution (~640px box; a ~1280px longest edge covers retina) BEFORE committing. Don't bundle multi-MB 4000px originals — that's repo bloat, slower renders, and pressure on the near-$0 / local-first line for no visible gain.

## 9. Banked tunables (not blockers)

- **58/38 hero/list split** — a fine starting point, but a gate-tunable like the overshoot was. Expect to nudge hero dominance on the clip.
- **Asset self-containment seam** — images in `remotion/public/` rather than the plugin folder is a slight self-containment leak for the eventual marketplace extraction. Fine now (it's how `staticFile` resolves; manifest + CREDITS already live in-folder). Known seam to tidy at extraction time: asset source-of-truth in the template + a build-copy step.
- Tier 3 (true 3D) remains parked.

## 10. Testing & gate

**Pure-first TDD:**
- `media.test`: image-hit, icon-hit, mark-fallback, plural-fold (phases→phase, planets→planet), source-swap (changing the manifest changes resolution), **icon-map covers every image-label (`imageManifest.keys ⊆ iconMap.keys`)**, `iconNameFor` icon-layer-only resolve (image-label → its icon name; unknown → null — this is what the list row of an image item uses, statically imported, never a runtime `require`).
- `enumeration-lucide.test`: every `ICON_MAP` name resolves to a real component in lucide's `icons` registry (a typo'd name would otherwise render a silent invisible span) — parallel to the icon-map invariant.
- `heroState.test`: exactly one hero at full presence mid-window; clean crossfade summing sanely at boundaries; nothing before the first reveal; crossfade completes within a tight gap and never leaves two heroes fully opaque; entrance reuses `itemRevealState`.
- Regressions stay green: onset-sync (motion CANNOT break voice-lock) + caption-suppress.

**Gate (the bigger mixed one):** real-audio render of sun/moon/planets/eclipse/phases + a 6-item clip + onset-sync table + entrance-amplitude readout (per the cycle-amplitude rule). Operator rules **icons + imagery + motion together**; image relevance/quality rides on curation. CREDITS completeness checked. Clips attached to chat for the reviewer (the build-box `cp` to uploads does not reach the reviewer container).

## 11. Sequencing

1. Tier-1 punch-up (`f3c7ae0`) merges into `development` (operator-owned; never master).
2. Cut `enumeration-visual-tier2` off `development` after that merge.
3. This design doc is the branch's first commit (held until the branch exists).
4. Plan → TDD pure helpers → Component rewrite → operator drops the curated PD set + provenance → gate.
