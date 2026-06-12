# Template Authoring Standard

> **Normative for v1.** This document covers every rule the installer enforces.
> `doctor` runs the same pipeline as `install` — if your template passes `doctor`,
> it is installable, byte-for-byte.  `npm run new-template` scaffolds a
> conforming starter you can use as the executable example of everything described
> here.

---

## 1. Anatomy & naming

A template is a plain folder.  The folder name **must equal the manifest `id`**
(the installer enforces this at stage 3).

```
my-card/
├── manifest.json        # required — the language-neutral contract
├── schema.ts            # required for content kinds; omit for transition
├── Component.tsx        # required for content kinds  (hook/scene/stat/…)
│   OR presentation.tsx  # required for kind: transition
├── assets/              # optional — only when the template ships media
│   ├── CREDITS.json     # required when assets/ exists (provenance)
│   └── *.png|svg|…
└── README.md            # optional — surfaced in the gallery drawer
```

**Id rules** (`^[a-z][a-z0-9-]{1,40}$`):
- lowercase letters, digits, and hyphens only
- starts with a letter; 2–41 characters total
- no leading dot; not `scripts` or `node_modules` (reserved names)

Examples: `my-card`, `kinetic-hook`, `wipe-v2`

---

## 2. The manifest, field by field

`manifest.json` is the contract between your folder and the Studio.  Every field
is read by both the Node installer and the Python backend — keep them in sync via
the generated `manifest.schema.json` drift check.

### Required fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Must match the folder name; see id rules above. |
| `name` | string | Human-readable display name, e.g. `"Kinetic Hook"`. |
| `version` | string | Semver, e.g. `"1.0.0"`. |
| `author` | string | Your handle or org name. `"core"` is reserved for built-in templates. |
| `apiVersion` | string | Always `"1"` for v1 — the SDK version gate, not yours. |
| `kind` | string | One of `hook`, `scene`, `stat`, `lower-third`, `transition`, `overlay`, `outro`. |
| `inputSchema` | object | JSON Schema for your props. **Never hand-edit this** (see §3). |
| `sampleProps` | object | Example props used to render the gallery preview. Must satisfy `inputSchema`. |
| `durationFrames` | object | `{"min": N, "max": N}` — the frame-count range your template supports. |

### Optional fields (v1.1)

| Field | Type | Purpose |
|---|---|---|
| `description` | string | One-line catalog/search text. Shown in the drawer. |
| `tags` | string[] | Search facets, e.g. `["numbers", "hero", "minimal"]`. |
| `license` | string | SPDX identifier, e.g. `"MIT"` or `"Apache-2.0"`. **Required for non-`core` authors** — the installer will reject your package if it is absent. |
| `homepage` | string | Author link shown in the drawer. |
| `assets` | string[] | Declared relative paths under `assets/` the installer must ship. Undeclared files are rejected; surprise payloads are not allowed. |

### `rendersOwnText`

Set `"rendersOwnText": true` when your component draws the narration text on
screen itself (hook/stat/outro hero cards).  The renderer suppresses the global
karaoke caption over the scene span to avoid double-printing.  **Lying about
this field double-prints captions on real video — set it correctly.**

If you are building a footage or overlay template that does not paint narration
text, omit the field (it defaults to `false`).

### `consumes`

Declare a content capability the recipe routes generically, e.g. `"enumeration"`.
When a beat's data shape matches the declared capability, the recipe routes it to
whichever template declares `"consumes": "<capability>"` — no hardcoded template
id.

**Do not invent capabilities.** A `consumes` value is a contract with the
recipe; undeclared values are silently ignored by the router, wasting the field.
Existing capabilities: `"enumeration"`.  Absent on most templates.

### Example — content kind

```json
{
  "id": "kinetic-hook",
  "name": "Kinetic Hook",
  "version": "1.0.0",
  "author": "acme",
  "apiVersion": "1",
  "kind": "hook",
  "description": "Word-cascade opening title with an accent underline sweep.",
  "tags": ["hook", "kinetic", "title"],
  "license": "MIT",
  "rendersOwnText": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": {"type": "string"},
      "kicker": {"type": "string"}
    },
    "required": ["title"],
    "additionalProperties": false
  },
  "sampleProps": {
    "title": "What if glass could flow?",
    "kicker": "MATERIALS"
  },
  "durationFrames": {"min": 30, "max": 120}
}
```

### Example — transition kind

Transitions hand-author `inputSchema` (no `schema.ts`; see §3).

```json
{
  "id": "wipe",
  "name": "Directional Wipe",
  "version": "1.0.0",
  "author": "studio-fps",
  "apiVersion": "1",
  "kind": "transition",
  "description": "Directional clip-path wipe transition.",
  "tags": ["transition", "wipe"],
  "license": "Apache-2.0",
  "inputSchema": {
    "type": "object",
    "properties": {
      "direction": {"enum": ["left", "right", "up", "down"]}
    },
    "additionalProperties": false
  },
  "sampleProps": {"direction": "left"},
  "durationFrames": {"min": 15, "max": 45}
}
```

---

## 3. Props: author zod once

### schema.ts (content kinds)

Create `schema.ts` and export a zod schema named `schema`.  This is **the single
source of truth** for your props.  The `gen-manifests` script (run by `npm run
build` in `templates/`; run it manually with `npm run gen-manifests` after you
edit `schema.ts`) reads `schema.ts` and regenerates the `inputSchema` field in
`manifest.json`. It is **not** auto-run on dev-server start, so regenerate and
re-run `doctor` after any schema change.

```typescript
// schema.ts
import {z} from 'zod';

export const schema = z
  .object({
    title: z.string(),
    subtitle: z.string().optional(),
  })
  .strict();          // .strict() → additionalProperties: false in the JSON Schema

export type MyCardData = z.infer<typeof schema>;
```

Type your component with `z.infer`:

```typescript
import type {MyCardData} from './schema';

const Component: React.FC<TemplateProps<MyCardData>> = ({data, theme, timing}) => {
  // data.title is typed as string; data.subtitle as string | undefined
};
```

### Never hand-edit `inputSchema`

The installer diffs your `inputSchema` against a fresh `gen-manifests` run at
stage 5.  A mismatch fails the install with a clear error.  Always let
`gen-manifests` own `inputSchema` for content kinds.

Transition kinds are the exception: they have a hand-authored `inputSchema`
(no `schema.ts`) because `gen-manifests` skips directories without a `schema.ts`.
The installer's stage 5 only checks `sampleProps`-vs-schema for transitions, not
the diff.

### sampleProps

`sampleProps` must satisfy your own schema — it is used to render the gallery
preview thumbnail.  The installer validates it at stage 5 and rejects packages
where `sampleProps` fails.

```json
"sampleProps": {
  "title": "What if glass could flow?",
  "subtitle": "A materials story"
}
```

---

## 4. The component contract

Your component receives a single `TemplateProps<Data>` object.  The contract is
normative — the installer's tsc check and the smoke render both enforce it.

```typescript
import type {TemplateProps} from '../sdk';
```

### Prop surface

| Prop | Type | Notes |
|---|---|---|
| `data` | `Data` | Validated against `inputSchema` before render. |
| `theme` | `Theme` | Active palette + fonts. Style from here only. |
| `timing` | `{fps: number; durationInFrames: number}` | Your canvas. You paint it; you never resize it. |
| `assets` | `ResolvedAssets` | `staticFile`-resolved paths for declared media. |
| `wordTimings?` | `HookWordTiming[]` | Render-derived narration timings. Absent/empty → fall back. |
| `itemTimings?` | `ItemTiming[]` | Render-derived item reveal frames. Absent/empty → fall back. |

### Style from theme tokens only

Do not hardcode colors, font families, or font sizes that belong to the brand.
Your template must look correct on any palette a user applies.

```typescript
// Correct — theme tokens
<div style={{
  backgroundColor: theme.palette.background,
  color: theme.palette.foreground,
  fontFamily: `${theme.fonts.heading}, system-ui, sans-serif`,
}}>
```

```typescript
// Wrong — hardcoded values
<div style={{backgroundColor: '#0a0a0a', color: '#ffffff', fontFamily: 'Inter'}}>
```

Available tokens: `theme.palette.background`, `.foreground`, `.accent`,
`theme.fonts.heading`, `.body`.

### Animate within timing.durationInFrames

You paint a span; you never decide one.

```typescript
const frame = useCurrentFrame();
const {durationInFrames} = timing;

// Entrance over the first 20 frames
const progress = interpolate(frame, [0, 20], [0, 1], {
  extrapolateLeft: 'clamp',
  extrapolateRight: 'clamp',
});
```

Never read frame counts from anywhere other than `timing` and `useCurrentFrame()`.
The recipe and assembler trust `durationFrames`; a component that ignores it
breaks sync.

### Deterministic & pure

- No network calls inside render.
- No `Date.now()` or `Math.random()` without a seed.
- No side effects that differ between renders of the same frame.

The smoke render and the preview render must produce identical frames given
the same inputs.

### Fail closed on render-derived timings

`wordTimings` and `itemTimings` are injected by the renderer and are absent
during preview generation, doctor runs, and any render where captions are
unavailable.  Your component **must produce a clean, non-crashing entrance in
all cases.**

```typescript
// Correct — fail-closed pattern
const synced = Boolean(wordTimings) && wordTimings!.length === words.length;

const wordStart = synced
  ? wordTimings![i].startFrame    // voice-locked
  : i * STAGGER_PER_WORD;         // even fallback
```

Never crash or render blank when these props are absent.

### Assets only via the assets prop

Declared media arrives at your component via `assets: ResolvedAssets`.  The
paths are `staticFile`-resolved and namespaced by the installer.  **Do not
build `staticFile()` paths by hand** — a hard-coded path breaks on any install
that differs from your dev tree.

```typescript
// Correct
<Img src={assets['assets/poster.png']} />

// Wrong
<Img src={staticFile('template-assets/my-card/assets/poster.png')} />
```

When no assets are declared, `assets` is an empty object — guard with a
conditional or provide a fallback.

Declare every file your component reads in `manifest.assets`; undeclared files
are rejected by the installer.  Ship `assets/CREDITS.json` with provenance
(title, source URL, license) for every shipped media file.

### Transitions: export a presentation factory

A `transition`-kind template exports a **factory function** as the default
export from `presentation.tsx`.  It receives `scene.transition.props` and
returns a `TransitionPresentation` built from `remotion` primitives.

```typescript
// presentation.tsx
import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentationComponentProps} from '@remotion/transitions';
import type {TransitionFactory} from '../sdk';

type P = {direction?: 'left' | 'right'};

const WipeComponent: React.FC<TransitionPresentationComponentProps<P>> = ({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}) => {
  const pct = presentationProgress * 100;
  if (presentationDirection === 'entering') {
    return (
      <AbsoluteFill style={{clipPath: `inset(0 ${100 - pct}% 0 0)`}}>
        {children}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill>{children}</AbsoluteFill>;
};

const presentation: TransitionFactory = (props) => ({
  component: WipeComponent,
  props: {direction: (props?.direction as 'left' | 'right') ?? 'left'},
});

export default presentation;
```

---

## 5. Dependencies — the frozen import surface (§15.6)

> **This is a hard rule enforced by the installer's import-lint (stage `imports`).**
> A violation names the offending import, the file, and this rule.

v1 templates may import **only** these bare package names:

| Package | Use |
|---|---|
| `react` | Component, JSX, hooks |
| `react-dom` | (rarely needed; allowed) |
| `remotion` | `AbsoluteFill`, `useCurrentFrame`, `interpolate`, `Img`, `staticFile`, … |
| `@remotion/transitions` | `TransitionPresentation`, `TransitionPresentationComponentProps` |
| `zod` | Schema definition in `schema.ts` (type-only at render time) |

**Relative imports** (`./schema`, `./utils`, `../sdk`) are always allowed —
they are your package-local files or the SDK type contract.

Anything else fails `doctor` with:

```
InstallError: imports — disallowed import "lodash" in Component.tsx — v1 templates
may import only react, react-dom, remotion, @remotion/transitions, zod (the frozen
import surface, §15.6). Relative imports (./…, ../sdk) are allowed.
```

### Why this rule exists

The Remotion renderer bundles templates at render time.  A bare import that is
not available in the renderer's `node_modules` (or not aliased in
`remotion.config.ts`) causes a bundle failure at render, not at authoring time.
The enumeration template's `lucide-react` icons needed a manual webpack alias in
`remotion.config.ts` — exactly the wall you must not hit blind.

Real dependency support (npm packages bundled with templates, webpack aliases
managed automatically) is the npm-package trajectory, planned for **M6**.  Until
then, the frozen surface is the complete import budget.

### What to do instead of third-party libraries

| Need | Frozen-surface alternative |
|---|---|
| Icon | Inline SVG path in JSX |
| Animation math | `interpolate` + custom functions in a helper file |
| Color manipulation | Inline arithmetic; CSS `color-mix()` |
| A component | Inline it in your `Component.tsx` or a relative `./helpers.tsx` |

---

## 6. Versioning

Follow **semver** for the `version` field in `manifest.json`.

| Change | Version bump |
|---|---|
| Breaking `inputSchema` change (removed or renamed required field) | **major** |
| New optional prop added | **minor** |
| Visual-only change (animation, color token, layout tweak) | **patch** |
| Bug fix, copy change | **patch** |

`apiVersion` is the SDK's version gate, not yours.  It stays `"1"` until the
SDK makes a breaking change — you do not control it.  Never increment
`apiVersion` yourself.

The installer enforces `apiVersion` at stage 4 and rejects packages that declare
an unsupported version.  When the SDK increments to `"2"`, a migration guide
will describe what to change.

---

## 7. Validate & package

### Step 1 — scaffold (optional)

Generate a working starter with all files pre-filled:

```bash
cd templates
npm run new-template -- --id my-card --kind scene --dir /tmp/my-card-workspace
```

The scaffold passes `doctor` untouched — it is the standard's executable example.
Edit `Component.tsx`, `schema.ts`, and `manifest.json` (author, name, description,
sampleProps) to match your design.

### Step 2 — doctor

Run the full install gate as a dry-run, without installing:

```bash
node templates/scripts/install.mjs doctor /tmp/my-card-workspace/my-card
```

`doctor` runs every stage the installer runs — envelope validation, id check,
compat check, schema diff, tsc, asset shipping, smoke render, and import-lint.
**Fix every error before proceeding.**  The staged output never touches
`templates/`; rollback is guaranteed.

Common failures and fixes:

| Stage | Error message (excerpt) | Fix |
|---|---|---|
| `imports` | `disallowed import "lodash"` | Remove or inline the import (see §5) |
| `schema` | `inputSchema drift` | Run `npm run gen-manifests` then re-run doctor |
| `schema` | `sampleProps failed validation` | Fix `sampleProps` to satisfy your zod schema |
| `typecheck` | TypeScript error in Component.tsx | Fix the type error |
| `preview` | Render threw or produced no frames | Fix the runtime crash in your component |
| `contract` | `license required for non-core templates` | Add `"license": "MIT"` (or your SPDX id) |

### Step 3 — pack

Once `doctor` reports OK, create the distributable zip:

```bash
node templates/scripts/install.mjs pack /tmp/my-card-workspace/my-card --out /tmp/my-card-workspace
# → /tmp/my-card-workspace/my-card-1.0.0.zip
```

`pack` runs `doctor` first and refuses to zip a failing template — you cannot
accidentally ship a broken package.

### Step 4 — install or submit

Drag the zip into the Studio's **Templates → Install** dropzone, or submit it to
the marketplace.  The installer verifies the sha256 from the catalog on
marketplace installs.

---

## Quick-reference checklist

- [ ] Folder name equals `manifest.id`
- [ ] `license` present (non-core authors)
- [ ] `schema.ts` exports `schema`; `inputSchema` is generated, not hand-edited (content kinds)
- [ ] `sampleProps` satisfies the schema
- [ ] Component imports only the frozen surface + relative files (§5)
- [ ] All styles use `theme.palette.*` and `theme.fonts.*` tokens
- [ ] `useCurrentFrame()` is never used outside `timing.durationInFrames`
- [ ] Fail-closed on absent `wordTimings`/`itemTimings`
- [ ] Assets declared in `manifest.assets`; `CREDITS.json` present when assets exist
- [ ] `doctor` reports OK
