# Design ratifications — closing the §7.3 drift items (2026-06-12)

**Context:** the development-branch review (§7, `development-branch-review.md`)
compared the built app against the confirmed flagship direction
(`studio-liquid-glass-flagship (1).html`) and found five places where the app
either diverged from a locked ruling or answered an open question silently.
Per "decide, don't drift," each is now an explicit decision, recorded here.

## 1. Glass material: **Regular, ratified + implemented**

The app's `.glass` read closer to the flagship's *Clear* variant (border only,
no specular edge). Ratified the flagship's **Regular** glass: inset top
highlight `inset 0 1px 0 rgba(255,255,255,.16)` + drop shadow
`0 14px 42px rgba(0,0,0,.45)` added to `.glass` in `globals.css` (token-true
values from the flagship `:root`). Clear remains available as a deliberate
choice for future surfaces, not the accidental default.

## 2. Theme: **dark-only for v1, ratified**

No light token set ships in v1. The flagship's light palette (`#5856D6` tint
set) exists as the source of truth whenever a light theme is scheduled; building
it is a *feature* (full token set + `color-scheme` + QA across five gates), not
a ratification. Until then dark-only is the honest, declared state — not drift.

## 3. Typography: **DM Sans in-app, ratified (open question closed)**

The locked ruling was system-stack in-app + DM Mono for ids, with an explicit
open question about going DM Sans everywhere. The build answered "yes"
(`--font-ui` = DM Sans via next/font); this ratifies it: **DM Sans is the app
face**, unifying app and marketing. DM Mono stays for ids/spec chrome.
Consequence (already documented in README): `next build` fetches both families
from Google Fonts at build time — offline builds fail. Self-hosting is the
escape hatch if that constraint ever bites CI.

## 4. Accessibility in the material: **RM + RT now; IC deferred**

Implemented in `globals.css`:
- `prefers-reduced-motion: reduce` collapses all chrome animation/transitions.
  The **player is exempt by design** — it renders the spec's own video, which
  is the product under review, not interface chrome.
- `prefers-reduced-transparency: reduce` goes near-solid and drops
  `backdrop-filter` — per the locked ruling this doubles as the low-GPU
  fallback.
- `prefers-contrast` (IC) is deferred to the contrast pass, as the review
  recommended.

## 5. Mobile player (Decision 2A, floating PiP): **own gate-reviewed feature**

Below `lg` the rail is `hidden` — there is currently *no* player on mobile.
The locked pattern (persistent floating PiP → fullscreen "exactly what
exports") is a feature with motion-review obligations, built on its own branch
(`mobile-pip`), eyes-on gated like any other motion work. This document only
ratifies the *scheduling*: it is the largest open delta and is next in line,
not silently absent.

## Non-decisions (explicitly left open)

- **Geometry-by-arithmetic:** the app uses a static radius scale + capsule
  discipline; the flagship's concentric frame→toolbar derivation has no app
  equivalent because the app has no framed-mock construction. Whether the
  radius tokens should *derive* (`calc(var(--radius-frame) - var(--inset))`)
  stays open until a surface exists where the difference is visible.
- **Hub's tinted navigation link** ("Render MP4 →" routes to /assemble) and
  multi-patch-card tint stacking — policy-level nits, parked.
