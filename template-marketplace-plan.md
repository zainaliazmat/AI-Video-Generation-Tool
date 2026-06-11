# Template Marketplace & Plugin Lifecycle — Design Plan (v1: local)

**Status:** LOCKED — eng review passed 2026-06-12 (9 in-review issues + 14 outside-voice findings, all ratified into §15, which **overrides** conflicting text in §1–§14). All six §14 decisions RULED (operator, 2026-06-12): #1 build-after-gates + re-grounding, #2 core protected set, #3 committed source folders + §15.11 git reality, #4 flat ids, #5 zip-only drag-drop, #6 theme/pack to M6. Build awaits only the M0 slot.
**Grounded on:** `development` @ `69339ca` (read in full by the reviewer, 2026-06-11).
**Build branch (proposed):** `template-marketplace` off `development`. All commits on-branch; push/PR/merge are the operator's call, per standing convention.
**Cost note:** this entire workstream is local tooling — **zero LLM / Tavily / Pexels spend.**

---

## 1. Ground truth — how templates work today (verified on the repo, not the handoff)

The plugin system is further along than the last handoff recorded. What's actually on `development`:

1. **A template plugin is a folder** `templates/<id>/` containing `manifest.json` + an entry file — `Component.tsx` for content kinds, `presentation.tsx` for `transition` kinds — plus optional `schema.ts` (zod, the single source of truth for props) and optional `assets/`. Transitions (`fade/`, `slide/`) are already plugins. (`templates/sdk.ts`, `templates/scripts/build-registry.mjs`)
2. **The manifest envelope is a lockstep contract** between `templates/sdk.ts` (TS `Manifest` interface) and `backend/manifest.py` (Pydantic `Manifest`): `id, name, version, author, apiVersion, kind, inputSchema, sampleProps, durationFrames, rendersOwnText?, consumes?`. `kind ∈ {hook, scene, stat, lower-third, transition, overlay, outro}`.
3. **Codegen chain:** `gen-manifests.ts` exports each zod schema to the manifest's `inputSchema` (JSON Schema, idempotent, rewrites only that field); `build-registry.mjs` scans folders → `registry.generated.ts` (static imports, discriminated `render | transition` union, deterministic sort). The registry file is **gitignored and regenerated** — it auto-runs on `predev/prebuild/prestart` in `preview/` and before `studio/render/bundle/typecheck` in `remotion/`.
4. **Unknown template id → loud `MissingTemplate` placeholder** at render (scenes, transitions, layers all guarded in `remotion/src/Video.tsx`). This is the uninstall-safety mechanism, already built.
5. **Backend validation:** `validate.load_catalog()` scans `templates/*/manifest.json`; `validate_spec()` enforces slot/kind legality + `jsonschema` props validation pre-render, failing loudly.
6. **Recipe routing:** deterministic position/data-shape mapping, **plus the capability standard's first brick has landed** — `manifest.consumes` is read generically (`_template_for_capability`), no hardcoded id, with graceful scene fallback. `derive()` itself remains deferred per the locked-architecture doc, which is in-repo at `docs/superpowers/specs/2026-06-08-layout-theme-architecture-design.md`.
7. **The gallery already hot-reads:** `preview/app/templates/page.tsx` is `force-dynamic` and `preview/lib/templates.ts` reads manifests fresh per request — the in-code comment says it outright: *"a dropped-in template shows up without a rebuild."* Previews are auto-rendered per template by `remotion/scripts/gen-previews.mjs` from `sampleProps` into `preview/public/previews/<id>.{mp4,jpg}`, with input-hash freshness in `previews.lock.json`.
8. **The consumption seam already exists:** the Assemble gate's patch whitelist (`backend/pipeline/spec_patch.py`) allows `scenes[i].template`, `templateProps`, `media`, `transition`, and `theme.*` — all validated against the live catalog (slot/kind + inputSchema) with the post-apply invariant guard. **A newly installed template is usable on a real video today via Assemble chat, with zero new selection machinery.**
9. **The original design intent covers this exactly:** phase-2 prompt §7 (in-repo) — folder plugins now; the same `manifest` + `TemplateProps` + registry contract must support npm packages and "eventually a runtime marketplace where templates install per user/tenant" **with no rewrite**; sandboxing/runtime-dynamic loading explicitly out of scope then.
10. **Known gap — asset shipping:** the enumeration template's images are `staticFile()` paths under `remotion/public/`, dropped there **manually by the operator**, with provenance in `assets/CREDITS.json`. There is no automated path from a template package's `assets/` into the render. The package spec below closes this.

**Deltas vs. the last handoff** (so nobody acts on the stale map): engagement Rounds 1–3 (heroBackground, hook word-sync, enumeration) are on `development`; transitions are plugin folders; the field is `sampleProps` (not `previewProps`); `gen-previews` lives in `remotion/scripts/`; the studio app is the `preview/` directory with the Studio-v2 session machinery merged.

---

## 2. Goals & non-goals

**Goals (this workstream)**
- Install / uninstall templates as plugins, safely and atomically, from a CLI, from the Studio UI, and via **drag-and-drop of a packaged template**.
- A **local marketplace**: a catalog folder in the repo the Studio can browse and search, with one-click install — shaped so the same catalog format and install path later point at a remote service unchanged.
- A **Template Authoring Standard**: a normative doc + scaffold + local validator (`doctor`) so a third party can build a conforming template without reading our source.

**Non-goals (explicitly deferred — consistent with the locked architecture and §7)**
- The `derive()` selector, AI selection, any `template → layout` rename, the per-scene override UI.
- Remote marketplace deployment, accounts, payments, package signing infrastructure (designed-for, not built).
- Runtime/dynamic component loading into a long-running prod server (v1 targets the dev-mode studio + CLI render, which re-bundle — see §13).
- Third-party code sandboxing (trust model stated honestly instead — §6.7, §13).
- `theme` and `pack` package kinds ship in a later milestone (M6) — the manifest reserves them now so nothing needs a rewrite.

---

## 3. The design at a glance

The deep insight from reading the repo: **almost everything a marketplace needs already exists as a seam.** Discovery is a folder scan; registration is codegen; validation is two-sided and fails closed; unknown ids render a loud placeholder; the gallery hot-reads; previews self-render from `sampleProps`; and Assemble's whitelist is the consumption path. The marketplace is therefore **not a new subsystem** — it is:

> a **package format** (the folder, zipped) + an **installer pipeline** (validate → stage → typecheck → smoke-render → register, fails closed, atomic) + a **catalog** (`marketplace/index.json` over a packages folder, behind a `MarketplaceSource` seam) + a **Studio surface** (tabs + search + install/uninstall + dropzone on the existing `/templates` gallery) + the **authoring standard** that makes third parties producible.

Nothing in the render path, the spec contract, the audio math, or the recipe changes.

---

## 4. The package format — Template Package v1

### 4.1 The distributable

The **unit of distribution is the template folder itself** — exactly the anatomy that exists today. The **transport form is a zip of that folder** (`<id>-<version>.zip`), produced by `npm run pack-template`. No new file types, no wrapper format: unzip → a valid `templates/<id>/` folder. This keeps the npm-package trajectory trivially open (the folder is already `package`-shaped; publishing later means adding a `package.json` per template, nothing structural).

```
my-card-1.2.0.zip
└── my-card/
    ├── manifest.json        # the contract (envelope below)
    ├── schema.ts            # zod props schema (content kinds; optional for transition)
    ├── Component.tsx        # or presentation.tsx for kind: transition
    ├── assets/              # optional bundled media
    │   ├── CREDITS.json     # REQUIRED when assets/ exists (provenance — enumeration precedent)
    │   └── *.png|svg|...
    └── README.md            # optional, surfaced in the gallery drawer
```

### 4.2 Manifest v1.1 — additive fields only

The existing envelope is untouched (no churn to `rendersOwnText`/`consumes` placement — consolidation under a `capabilities` object is a later isolated migration if ever). Added, all optional except where noted:

| Field | Type | Purpose |
|---|---|---|
| `description` | string | catalog/search text (backfill the core templates) |
| `tags` | string[] | search facets (`"numbers"`, `"hero"`, `"minimal"`) |
| `license` | string | SPDX id; required for non-`core` authors |
| `homepage` | string? | author link in the drawer |
| `assets` | string[]? | declared relative paths under `assets/` the installer must ship (undeclared files are rejected — no surprise payloads) |

`author` stays a string; `author: "core"` marks built-ins (see protected set, §6.6). `apiVersion` is the compat gate (§6.4). Integrity (`sha256`) lives **catalog-side**, not in the package (a package can't attest itself).

**Lockstep discipline:** both `templates/sdk.ts` and `backend/manifest.py` gain the fields in one commit, plus a **generated `templates/manifest.schema.json`** — emitted from the Pydantic model (`model_json_schema()`) by a tiny script and CI-diff-checked, exactly the regenerate-and-diff pattern `gen-manifests` already uses. This gives the node-side installer (and any future remote service) **one validator with zero third-copy drift**: Pydantic stays the source of truth; TS and the JSON Schema are checked against it.

### 4.3 Kinds in scope

**v1 installs every kind `build-registry` discovers today** — content kinds and `transition`. Reserved for M6 (designed now, not built): `kind: "theme"` (a data-only package: `theme.json` validated against the spec's `Theme` schema, no component — themes today are inline spec objects, so this needs a named-preset catalog first) and `kind: "pack"` (a manifest whose `contents: [{id, path}]` the installer loops over). This is the layout ⊥ theme marketplace exactly as locked: either axis ships alone; a pack is just a bundle.

### 4.4 Assets contract (closes the §1.10 gap)

A package's `assets/` directory is installed to **`remotion/public/template-assets/<id>/`** (namespaced — no collisions), and `copy-assets.mjs` mirrors `template-assets/` into `preview/public/` so the studio player resolves the same URLs. The SDK's `assets: ResolvedAssets` prop is the access path — the authoring standard forbids hand-built `staticFile()` strings so installs stay relocatable. `CREDITS.json` is mandatory when assets exist; the installer rejects packages with undeclared files in `assets/`. Uninstall removes the namespace directory.

---

## 5. Folder topology

```
templates/                      # the INSTALLED set — unchanged, still what every scanner reads
  hook/ scene/ stat/ outro/ overlay/ enumeration/ fade/ slide/   # core (protected)
  <installed-id>/               # third-party installs land here
  registry.generated.ts         # gitignored, regenerated (unchanged)
  manifest.schema.json          # NEW: generated from Pydantic, committed + drift-checked
  scripts/
    build-registry.mjs          # unchanged
    gen-manifests.ts            # unchanged
    install.mjs                 # NEW: installer CLI (install/uninstall/list/doctor/pack)
    new-template.mjs            # NEW: scaffold
    build-marketplace-index.mjs # NEW: catalog builder

marketplace/                    # the LOCAL STORE (committed)
  index.json                    # the catalog — generated by build-marketplace-index
  packages/
    <id>/<version>/<id>-<version>.zip
```

`templates/` = "what's installed"; `marketplace/` = "what's available." Install copies across the boundary through the pipeline below — never a bare `cp`. The future remote marketplace is the **same `index.json` shape + the same zips served over HTTP**; only the source implementation changes (§7.2).

---

## 6. The installer pipeline — fails closed, atomic, loud

One implementation, three entry points: the CLI (`node templates/scripts/install.mjs install <zip|dir>`), the Studio API route (`POST /api/templates/install`), and the marketplace one-click (which resolves a catalog entry to its zip, verifies `sha256`, then calls the same function). Stages, in order — **any failure aborts with the stage name and the specific violation; nothing is registered partially:**

1. **Unpack to a temp staging dir.** Zip-slip guard (reject `..`/absolute paths), size cap (default 50 MB), single-top-level-folder check, folder name must equal `manifest.id`.
2. **Envelope validation** against the generated `manifest.schema.json` (§4.2) — one validator, no drift.
3. **Id rules + collision check.** `^[a-z][a-z0-9-]{1,40}$`. Id already installed → reject, unless `--update` and incoming `version` is semver-greater (then the old folder is snapshotted for rollback).
4. **Compat gate.** `apiVersion` must equal the SDK's supported version (`"1"`). This is the field that lets a future SDK break cleanly instead of silently.
5. **Schema integrity.** If `schema.ts` exists: run `gen-manifests` against the staged copy and **diff** the produced `inputSchema` against the shipped one — mismatch means the package was built stale; reject. (Transitions without `schema.ts` keep hand-authored schemas, as today.) Then validate `sampleProps` against `inputSchema` — the preview render depends on it.
6. **Stage → typecheck → rollback on fail.** Move the folder into `templates/`, run `build-registry` + `tsc --noEmit -p templates/tsconfig.json`. v1 typechecks the whole package (honest and simple); a compile error removes the folder, re-runs `build-registry`, restores any `--update` snapshot. Built-ins (`author: "core"`) are **protected**: uninstall refuses them, because the recipe's default slot mapping and `theme.transition` reference their ids.
7. **Smoke render = the preview.** Run `gen-previews --only <id>` (a small flag addition to the existing script): renders `TemplatePreview` from `sampleProps` → the gallery `mp4 + jpg`. This doubles as the runtime smoke test — a component that throws fails the install, and a component that renders produces **pixels the human sees before trusting it further.** Install isn't done until the preview exists.
8. **Assets ship** per §4.4; `previews.lock.json` updated.
9. **Register + report.** `build-registry` already ran; print/return the summary `{id, version, kind, preview}`.

**Uninstall:** refuse `core`; scan `projects/*/spec.json` for references and **warn with the count** (renders of those projects fall back to the loud `MissingTemplate` placeholder — already safe by design); remove folder + previews + lock entry + asset namespace; `build-registry`.

**`doctor <dir|zip>`** runs stages 1–7 against a throwaway staging area without committing anything — the author's local validator and the exact same code path the marketplace will trust, so "doctor-clean" means "installable."

**Trust model, stated honestly (v1):** a template is executable TSX in the render process. The local marketplace ships first-party/curated packages with catalog-side `sha256`; drag-and-drop installs run the author's code on the author's machine. The Studio surface says so in plain words (§8). Sandboxing/signing is the remote marketplace's gate, designed-for via `apiVersion` + catalog integrity, not built now — consistent with §7 of the original phase prompt.

---

## 7. The local marketplace store

### 7.1 The catalog — `marketplace/index.json`

Generated by `build-marketplace-index.mjs` (walks `marketplace/packages/`, reads each zip's manifest, hashes the zip):

```json
{
  "catalogVersion": 1,
  "generatedAt": "2026-06-11T00:00:00Z",
  "packages": [
    {
      "id": "kinetic-hook",
      "name": "Kinetic Hook",
      "version": "1.0.0",
      "kind": "hook",
      "apiVersion": "1",
      "author": "acme",
      "license": "MIT",
      "description": "Word-cascade opening title with accent underline.",
      "tags": ["hook", "kinetic", "bold"],
      "package": "packages/kinetic-hook/1.0.0/kinetic-hook-1.0.0.zip",
      "sha256": "…",
      "preview": { "poster": "packages/kinetic-hook/1.0.0/poster.jpg" }
    }
  ]
}
```

Catalog previews are the **author's** rendered poster shipped beside the zip (so browsing needs no install); the **installed** preview is always re-rendered locally at stage 7 — the local render is the trusted one.

### 7.2 The `MarketplaceSource` seam

```ts
interface MarketplaceSource {
  getIndex(): Promise<CatalogIndex>;
  fetchPackage(entry: CatalogEntry): Promise<{ zipPath: string }>;  // sha256-verified
}
```

v1 ships `LocalFolderSource` (reads `marketplace/`). The future remote is `HttpSource` — same index JSON, same zips, same hash check, pointed at a CDN — plus whatever auth the business layer wants. This is the **same strategy-seam shape as the pluggable LLM provider**: the consumer (Studio routes) never knows which source it's talking to. **Search in v1 is a client-side filter** over the fetched index (name/tags/kind/author) — no server search until a remote index is big enough to need one.

---

## 8. Studio surface — extending `/templates`

The gallery already exists (`TemplateGallery` / `TemplateCard` / `TemplateDrawer`) and hot-reads manifests. The extension:

- **Two tabs: Installed | Marketplace**, plus a search field filtering both (id/name/tags/kind/author).
- **Installed tab:** today's cards + version/author/kind badges; non-`core` cards get **Uninstall** (confirm dialog shows the project-reference count from the scan). A **dropzone** ("Drop a template .zip to install") sits at the top of this tab.
- **Marketplace tab:** catalog cards (author poster, description, tags) with **Install** — the screen's one tinted action, per the design language. Install streams the pipeline stages as progress states (`validating → typecheck → rendering preview → done`), reusing the `_spawn.ts` pattern the API routes already use; on success the card flips to "Installed ✓" and the Installed tab now shows the locally-rendered preview playing.
- **Drag-and-drop** = `POST /api/templates/install` (multipart zip) → the same pipeline → the same progress UI → a new card with a fresh, locally-rendered preview. Zip-only in v1 (directory drop via `webkitGetAsEntry` is a later nicety). Failures surface the **stage + exact violation** ("schema integrity: shipped inputSchema is stale — re-run gen-manifests"), never a generic toast.
- **Trust copy, honest-naming discipline:** the dropzone and every third-party Install carry one plain sentence — *"Templates run code in the renderer during preview and export. Install only templates you trust."*
- **Consumption story shown in the drawer:** an installed template's drawer gains "Use it: open a video's Assemble gate and ask for it" — because `scenes[i].template` is already whitelisted and validated, this works **today** with zero selection machinery. When `derive()`/override UI land later, installed templates are already eligible by manifest.
- **Liquid Glass notes:** tab bar/search/install bar are the floating glass control layer; cards stay `.content-card` standard material; one tinted action per screen; capsule geometry by arithmetic, as locked.
- **Freshness reality (stated, not hidden):** manifests/previews hot-read (`force-dynamic`); the **player bundle** picks up a newly installed component via dev-mode HMR of `registry.generated.ts`, and CLI renders always re-run `build-registry`, so install→render works unconditionally. A `next start` production server would need a rebuild for the *in-app player* to show the new component — v1 targets the dev-mode studio; runtime module loading stays deferred (§2).

---

## 9. The Template Authoring Standard

Three deliverables — a doc, a scaffold, and the validator (which is just `doctor`, §6):

### 9.1 `docs/TEMPLATE-AUTHORING.md` (normative — outline)

1. **Anatomy & naming** — the folder layout (§4.1); id rules; folder name == id.
2. **The manifest, field by field** — including when `rendersOwnText` must be `true` (your component draws the narration text itself; lying about it double-prints captions) and what `consumes` means (declare a content capability the recipe routes generically; don't invent capabilities — they're a contract with the recipe).
3. **Props: author zod once.** `schema.ts` exports `schema`; `z.infer` types your component; **never hand-edit `inputSchema`** — `gen-manifests` owns it, and the installer diffs it (stage 5). `sampleProps` must satisfy your own schema; it is what renders your gallery preview.
4. **The component contract** (made normative from `sdk.ts`'s doc comments):
   - You receive `TemplateProps`: `data, theme, timing, assets` (+ render-derived `wordTimings?`/`itemTimings?`).
   - **Style from `theme` tokens only** — no hardcoded colors/fonts; your template must survive any palette.
   - **Animate with `useCurrentFrame()` strictly inside `timing.durationInFrames`.** You paint a span; you never decide one. No layout may touch span count, ordering, or timing — that invariant is structural and the renderer/validator assume it.
   - **Deterministic & pure:** no network, no `Date.now()`, no unseeded randomness — a frame must render identically every time.
   - **Fail closed on render-derived timings:** absent/empty `wordTimings`/`itemTimings` → your non-synced entrance, never a crash or a blank.
   - **Assets only via the `assets` prop** (relocatable installs); declare them in the manifest; ship `CREDITS.json`.
   - Respect `durationFrames` honestly — the recipe and assemble trust it.
   - Transitions: export a presentation **factory** from `presentation.tsx`, built on `remotion` primitives.
5. **Versioning** — semver: breaking `inputSchema` change → major; visual-only → minor/patch. `apiVersion` belongs to the SDK, not you.
6. **Validate & package** — `doctor` until clean (it is byte-for-byte the install gate), then `pack-template` → the zip you can drag into any Studio or submit to the marketplace.

### 9.2 Scaffold

`npm run new-template -- --id my-card --kind scene` → a working starter (manifest stub with the new fields, `schema.ts` with one prop, `Component.tsx` demonstrating theme-token styling + a frame-driven entrance + the fail-closed pattern, `assets/CREDITS.json` stub, README). The starter must pass `doctor` untouched — the standard's executable example.

### 9.3 `pack-template`

`npm run pack-template -- --id my-card` → `dist/my-card-<version>.zip` (runs `doctor` first; refuses to pack a failing template).

---

## 10. Invariants this workstream must not break (restated)

- **1 beat = 1 narration span = 1 scene**; templates paint spans, never define them. Install/uninstall **never touches any project's `spec.json`**; missing ids render the loud `MissingTemplate` placeholder.
- **Rendering reads only the spec.** No selector is being built; the recipe's routing is unchanged — `consumes` remains the only generic signal, exactly as locked. The spec field stays `scene.template` (no rename).
- The core `spec.json` contract (`backend/schema.py` ↔ `remotion/src/schema.ts`) is untouched. The **manifest** contract changes are additive and land as one lockstep commit across `sdk.ts` + `manifest.py` + the generated `manifest.schema.json`, with drift tests.
- The frozen `SYSTEM_PROMPT` (① rule), audio math, caption suppression, and the Assemble whitelist semantics are untouched.
- Git discipline: everything on `template-marketplace`; the git-guard hook governs; PR/merge is the operator's UI action.

---

## 11. Build plan — milestones (each TDD'd, each gated)

**M0 — Sequencing + branch.** This plan is locked now; the build slot starts **after the Studio-v2 merge-gate items clear** (reviewer pixel review, live cycle, `CaptionStyle.size` ruling, PR) so we're not stacking two unmerged workstreams on `development`. Branch `template-marketplace` off `development` when the slot opens.

**M1 — Manifest v1.1 + the third validator.** Additive fields in `sdk.ts` + `manifest.py` (one commit); `gen-manifest-schema` script → committed `templates/manifest.schema.json` + drift check; backfill `description/tags/license` on the core manifests. *Gate:* backend tests green incl. new lockstep tests; `build-registry`/`gen-manifests` byte-stable on unchanged inputs.

**M2 — Installer core + doctor.** `install.mjs` (install/uninstall/list/doctor/pack as pure functions + CLI), `gen-previews --only <id>`, asset shipping + namespacing, rollback, reference scan, protected built-ins. *Gate:* vitest suite over **fixture packages covering every failure stage** (§12) + a happy-path fixture installed→uninstalled cleanly; Python `load_catalog` still loads everything; full backend suite green.

**M3 — Local store + seam + seed.** `marketplace/` layout, `build-marketplace-index.mjs`, `MarketplaceSource`/`LocalFolderSource`, sha256 verify. **Seed the catalog with 2–3 real demo packages authored as if third-party** (`author != core` — e.g., a variant hook, a wipe transition): this proves the standard produces installables before any outsider tries. *Gate:* index round-trip tests; install-from-catalog e2e on the seeds.

**M4 — Studio surface.** Tabs, search, install/uninstall with streamed stage progress, dropzone, trust copy, drawer "use it" note. *Gate:* the standing visual discipline — **motion clips uploaded to `/mnt/user-data/uploads/`**: (a) drag-drop → stage progress → new card's preview playing; (b) a failing zip showing the loud stage error; (c) uninstall with the reference warning; (d) search filtering. The reviewer looks and identifies independently.

**M5 — Authoring kit.** `TEMPLATE-AUTHORING.md`, `new-template`, `pack-template`. *Gate — the clean-room proof:* scaffold → small edit → `doctor` → `pack` → **drag-drop install → appears in the gallery → switched onto a real video via the Assemble gate → rendered frames reviewed.** That closes the loop the user asked for end-to-end.

**M6 — deferred, design-only notes kept warm:** `theme` + `pack` kinds (needs the named-theme-preset catalog); `HttpSource` + signing/review for the remote marketplace; prod-server runtime loading; `derive()` integration when Round-3's successor lands it — installed manifests are already eligibility-shaped (`kind`, `inputSchema`, `consumes`), so nothing here needs rework.

---

## 12. Test matrix (M2 fixtures — one per failure stage)

| Fixture | Expected |
|---|---|
| `valid-scene.zip` | installs; preview rendered; catalog + registry list it |
| `valid-transition.zip` | installs via `presentation.tsx` path |
| `zip-slip.zip` (`../evil`) | stage 1 reject |
| `bad-envelope.zip` (missing `kind`) | stage 2 reject, names the field |
| `id-collision.zip` (id `hook`) | stage 3 reject; `--update` on `core` also refused |
| `wrong-api.zip` (`apiVersion: "2"`) | stage 4 reject |
| `stale-schema.zip` (shipped `inputSchema` ≠ zod) | stage 5 reject |
| `bad-sample.zip` (`sampleProps` fail own schema) | stage 5 reject |
| `tsc-error.zip` | stage 6 reject + **rollback verified** (folder gone, registry rebuilt) |
| `throws-at-render.zip` | stage 7 reject + rollback |
| `undeclared-asset.zip` / missing `CREDITS.json` | asset-contract reject |
| uninstall of a referenced template | warns with count; render shows `MissingTemplate` (existing test extended) |

---

## 13. Risks & mitigations

- **Arbitrary code execution** — inherent to the format; mitigated by the stated trust model, catalog `sha256`, zip-slip/size guards, and the fact that v1 distribution is local/curated. The remote marketplace adds review/signing **before** it adds strangers.
- **Three-way contract drift** (TS/Pydantic/JSON-Schema) — killed by generating the third from the first and drift-checking in CI, the codebase's existing pattern.
- **Whole-package typecheck blast radius** (a broken third-party template fails `tsc` for everything until rolled back) — acceptable because rollback is atomic and tested; per-template isolated typecheck is a later optimization.
- **Asset collisions / provenance** — namespaced `template-assets/<id>/`, declared-files-only, mandatory `CREDITS.json`.
- **Prod-server player staleness** — stated honestly in §8; dev-mode + CLI render are fully covered; runtime loading is M6+ by design.
- **`previews.lock.json` churn** — `--only` keeps regeneration scoped to the installed id.

---

## 14. Open decisions — ALL RULED (operator, 2026-06-12, per eng review D2/D6/D17/D18/D20/D22): every lean below is ratified as written

1. **Sequencing (blocks M0):** agree the build slot opens after the Studio-v2 merge gates clear? *Reviewer lean: yes — lock the plan now, build after; don't stack a third unmerged workstream.*
2. **Protected set:** `author: "core"` = uninstallable (hook/scene/stat/outro/overlay/enumeration/fade/slide). *Lean: yes for v1 — the recipe's defaults and `theme.transition` reference them.*
3. **Third-party installs in git:** committed to the repo (local-first, reproducible checkouts) vs. gitignored (treat like downloaded footage). *Lean: committed — a checkout should render; revisit at multi-tenant.*
4. **Id namespacing:** flat ids now (`kinetic-hook`) with `core` reserved, npm-style scopes (`@acme/hook`) only when remote ships. *Lean: flat — scopes are a remote-marketplace problem.*
5. **Drag-drop accepts zip only in v1** (folder drop later). *Lean: yes.*
6. **Theme/pack kinds to M6** (v1 = component-bearing kinds only). *Lean: yes — keeps v1 shippable; manifest already reserves the shape.*

---

## 15. Ratified review amendments (2026-06-12) — normative; overrides §1–§14 where they conflict

From the eng review (8 issues) + independent outside voice (14 findings), every item below operator-approved individually.

### 15.1 Assets pipeline is real, shared, and gate-visible (Issues 1A + OV-1)
- **M2 builds the assets resolver**: a shared helper (one module) maps `manifest.assets` → `{relPath: staticFile('template-assets/<id>/…')}`, used by **both** `remotion/src/Video.tsx` and `remotion/src/TemplatePreview.tsx` (both currently pass `assets={{}}`).
- **Stage order fix**: assets ship to `remotion/public/template-assets/<id>/` **before** the smoke render (between typecheck-pass and stage 7), so the install gate exercises asset resolution. Rollback removes the asset namespace too.
- **Enumeration backfills** to the assets prop in M2 — core follows the standard it ships.

### 15.2 Verify-before-register install ordering + lock (Issues 2A + OV-10/OV-6)
Revised stage 6–7 sequence (replaces §6.6–6.7 mechanics):

```
unpack→validate (stages 1–5, in templates/.staging/<run-id>/)
   │
   ▼
move templates/.staging/<run-id>/<id> → templates/<id>/          (registry UNTOUCHED)
   │
   ▼
tsc --noEmit  (remotion/tsconfig.json — its include covers ../templates/**/*.tsx;
   │           templates/tsconfig.json checks only sdk.ts + schema.ts and is NOT the gate)
   ├─ fail → rm templates/<id>/ → nothing to rebuild → loud report   (live studio never affected)
   ▼ pass
ship assets → build-registry (register) → gen-previews --only <id> --force
   ├─ fail → rollback: rm folder + asset namespace, build-registry, restore --update snapshot
   ▼ pass
update previews.lock → report {id, version, kind, preview}
```

- **Single-flight install lock**, same module-flag pattern as `render/route.ts:18`, shared across install/uninstall/doctor; concurrent request → 409.
- **Crash-window sentinel (`.installing`)**: written into the candidate folder at move time, deleted at stage 9. `build-registry`'s `discover()` skips folders containing it (one-line change, byte-stable regression run required), and the installer sweeps stale sentinel folders at startup — a crash mid-install leaves an inert, scanner-invisible folder instead of silently auto-registering an unverified template on the next `predev`.
- **`doctor` mechanics stated honestly**: stages 6–7 require temporary live registration (static-import registry; gen-previews discovers only `templates/` children) — doctor = post-tsc temp-register + guaranteed full rollback, holds the same lock, and carries implicit `--update` semantics when the id is already installed.
- **`gen-previews --only <id>` force-renders** (ignores the lock hash), and the input hash widens to the **whole template folder including `assets/`** (today it covers only entry file + sampleProps + harness — helper-only updates would silently skip the smoke gate).

### 15.3 Id safety (Issue 3A)
Stage 3 adds: reserved-name set `{scripts, node_modules, any leading-dot}`; collision check is **disk-folder existence**, not just catalog membership (`templates/scripts/` has no manifest and would otherwise pass).

### 15.4 Marketplace stores source, not blobs (Issue 4A)
`marketplace/packages/<id>/<version>/` holds the **package source folder** (reviewable in PRs — curation with teeth). `build-marketplace-index.mjs` builds the zip **deterministically** (fixed mtimes, sorted entries) + `sha256` at index time. Install path still consumes zips, unchanged.

### 15.5 Install route donor pattern (Issue 5A)
§8's streaming reference to `_spawn.ts` is wrong — that's buffered one-shot JSON. The donor is **`preview/app/api/render/route.ts:66-161`** (SSE + single-flight + process-group kill + timeout + disconnect cleanup). M4 extracts a shared SSE-spawn helper used by both routes.

### 15.6 Stage-5 mechanics + honest trust copy (Issues 6A + OV-2)
- `gen-manifests.ts` gains `--dir` (it hardcodes `templatesDir` today); staging is pinned to **`templates/.staging/<run-id>/`** (gitignored) so the staged `schema.ts` resolves `zod` up the node_modules chain; dot-folder is invisible to build-registry, tsc globs, and gen-previews.
- Trust copy (dropzone + third-party installs): *"Templates run code on your machine during install validation, preview, and export. Install only templates you trust."* (`doctor`/stage 5 **execute** the package's `schema.ts` via dynamic import — said plainly.)
- **Frozen import surface (authoring standard §9.1 gains a "Dependencies" section)**: v1 templates may import only `react`, `remotion`, `@remotion/transitions`, `zod` (types). Anything else fails — enumeration's lucide-react needed a manual `remotion.config.ts` webpack alias, which is exactly the wall a third party must not hit blind. `doctor` lints imports against the allowlist and names the rule on violation. Real dependency support = the npm-package trajectory, M6.

### 15.7 Mirror hygiene (Issue 7A)
`copy-assets.mjs` treats `preview/public/template-assets/` as a **managed mirror with orphan deletion** (delete logic strictly scoped inside that namespace; the stock `assets/` mirror behavior untouched).

### 15.8 Capability uniqueness (OV-3)
Stage 3 rejects a package whose `consumes` duplicates an existing provider's capability (`_template_for_capability` returns first-alphabetical — an `aaa-*` id would silently steal routing). Override is an explicit `--override-capability` only.

### 15.9 Honest uninstall consequence (OV-4)
The §6 uninstall warning and M4 confirm dialog state the true two-tier consequence: *the preview player shows the MissingTemplate placeholder; **editing/assembling/re-rendering that project will fail loudly** until the template is reinstalled or the scene re-templated* (backend `validate.py` hard-fails on unknown ids — it does not degrade). M2 verifies at build time whether any legacy root-`spec.json` read path is still live and includes it in the reference scan iff real.

### 15.10 Overlay honesty (OV-5)
Overlay-kind installs remain allowed, but the drawer's "Use it" copy is **kind-aware**: overlays cannot be applied via Assemble chat (`spec_patch.py` has no `layers` path — verified) — copy says so and names the layers-whitelist extension as M6 work. §8's universal "usable via chat today" claim is corrected to content-scene kinds + transitions + theme.

### 15.11 Git reality of installs (OV-8)
The installer **never touches git**. Committing an install is the operator's deliberate act on a deliberate branch (per repo git discipline; git-guard governs). The Studio shows an "uncommitted install — commit when ready" hint after a successful install. §14.3's "committed" means *the operator commits source folders*, nothing automatic.

### 15.12 M0 re-grounding (OV-9)
The build slot's first act is **re-grounding against the then-current `development` tip** (this plan's base is 49–53 files stale: PRs #23–25 + the pending Studio-v2 merge rewrite Assemble-gate surfaces M4/§8 touch). Re-grounding is a named M0 deliverable, not a vibe.

### 15.13 Validator honesty + guards (OV-11/12/13/14)
- Pydantic `Manifest` gets `extra="forbid"`; the plan names the **imperative check layer** (license-required-iff-non-core, CREDITS-iff-assets) — "one validator" means one *schema* validator plus one named imperative pass, not zero hand checks.
- Stage 5's regenerate-and-diff integrity check **does not apply to transitions** (hand-authored `inputSchema`) — weaker gate stated; only sampleProps-vs-schema applies there.
- Stage 1 adds **decompressed-size cap (default 200 MB) and entry-count cap (default 2 000)** alongside the 50 MB compressed cap (zip-bomb guard).
- Install progress UI sets the latency expectation: the smoke-render stage says *"rendering preview — this can take a couple of minutes"* (two full Remotion bundles on a CPU-only box at concurrency 2).

### 15.14 Test matrix additions (Issue 8A + regression rule) — §12 grows to 27
**Mandatory regressions (no-skip):** (R1) no-assets template renders identically after the resolver lands; (R2) `gen-manifests` with no `--dir` flag produces byte-identical output; (R3) `copy-assets` never touches the stock `assets/` mirror.
**New fixtures/tests:** sha256-mismatch (tampered catalog zip); `--update` semver-up happy path (snapshot+replace) and downgrade reject; reserved-id (`scripts`) + disk-existence collision; compressed/decompressed/entry-count cap fixtures; asset-bearing render proof (component displays shipped asset via the resolver) + enumeration-backfill identical-render check; concurrent install → 409; uninstall cleans the preview mirror; route error trio (non-zip, oversize, unknown catalogId); deterministic-zip double-build hash stability; scaffold-passes-doctor as a CI test; `gen-previews --only` scoping (only target re-rendered) + helpers-only-change forces re-render; consumes-collision reject; crash-window sentinel (folder bearing `.installing` → build-registry skips it; startup sweep removes it). **§12 total: 28.**

---

## Appendix A — manifest v1.1 example (third-party)

```json
{
  "id": "kinetic-hook",
  "name": "Kinetic Hook",
  "version": "1.0.0",
  "author": "acme",
  "apiVersion": "1",
  "kind": "hook",
  "description": "Word-cascade opening title with accent underline.",
  "tags": ["hook", "kinetic", "bold"],
  "license": "MIT",
  "assets": ["assets/underline.svg"],
  "inputSchema": { "…": "generated from schema.ts by gen-manifests" },
  "sampleProps": { "line": "What if glass could flow?", "kicker": "MATERIALS" },
  "durationFrames": { "min": 30, "max": 120 },
  "rendersOwnText": true
}
```

## Appendix B — CLI / API sketch

```
node templates/scripts/install.mjs install ./kinetic-hook-1.0.0.zip
node templates/scripts/install.mjs install --from-marketplace kinetic-hook
node templates/scripts/install.mjs uninstall kinetic-hook
node templates/scripts/install.mjs doctor ./my-card/
npm run new-template -- --id my-card --kind scene
npm run pack-template -- --id my-card

POST /api/templates/install        (multipart zip | {catalogId})  → SSE stage progress
DELETE /api/templates/:id          → {removed, referencedBy}
GET /api/marketplace/index         → MarketplaceSource.getIndex()
```

## 16. Design review amendments (2026-06-12) — normative for M4 (+ named M2 deltas); companion to §15, operator-ratified D5–D19

From /plan-design-review: eyes-on wireframe gate (token-true HTML, approved D3, amended D7/D12/D13/D14) + independent outside voice (15 findings, single-model) + 7 review passes. Every item below ruled individually. Where §16 conflicts with §8/§15 UI prose, §16 wins.

### 16.1 Approved visual reference (D3, D18)
`~/.gstack/projects/zainaliazmat-AI-Video-Generation-Tool/designs/templates-marketplace-20260612/wireframe.html` (+ `approved.json`) is the M4 visual reference — built from the live `globals.css` tokens, updated post-passes to match every ruling below. Pictures and prose now agree; the M4 builder opens both.

### 16.2 Screen composition (D3 + D5)
Stack: header → glass segmented tab bar (`Installed N · Marketplace M`) beside a glass search field → ghost **"Install from .zip"** button (file picker) → kind pills → one quiet trust line → grid. **No permanent dropzone** — a whole-page drag overlay arms on `dragenter` ("Drop to install — .zip template package"). Search filters the active tab; **both tab-label counts update with the query** (cross-tab visibility without switching); pills facet the active tab. Headline count = **installed only**; subtitle gains "+ M more in the local marketplace." Zero-result search states cross-link the other tab ("N matches in Marketplace →" + clear-search).

### 16.3 Install progress contract (D6)
In-card **stage checklist** (mono 12px rows: ✓ done / pulsing current / dim pending) — **no percent bar**; stage durations aren't linear and we don't fabricate numbers. Latency copy on the render stage per §15.13. **Disconnect ≠ abort** — explicit delta from the render donor: the §15.5 shared SSE helper gains a keep-alive-on-disconnect mode for installs; the install runs to completion or rollback server-side; revisiting re-syncs from the single-flight lock/state. **409** = inline on the attempted card: "An install is already running — one at a time." The pulse collapses under `prefers-reduced-motion` (chrome, not player).

### 16.4 Update & collision (D7) — amends §6 stage 3
Card state triad: **Install / Installed ✓ / Update to x.y.z** (catalog version > installed). Re-drop of an installed id → inline confirm in the drop-result surface (no modal): "'<id>' v<x> is already installed — Replace / Cancel." **Same-version replace is allowed only through this explicit confirm** (stage 3 relaxes semver-greater to semver-≥-with-confirm; the author iteration loop must not require a version bump per attempt); **downgrades stay rejected**. +1 fixture: same-version replace happy path via confirm flag — **§12 total: 29.**

### 16.5 Interaction state matrix (D3 + D8)
| Surface | Loading | Empty | Error | Success | Partial/edge |
|---|---|---|---|---|---|
| Marketplace tab | 4 pulse-skeleton cards | warm empty: "The local marketplace is empty" + `new-template` / drop hint | index missing/corrupt: inline error + rebuild hint | catalog grid | search zero-results w/ cross-tab link |
| Install (card) | stage checklist (16.3) | — | red stage-block: stage + exact violation + Retry/Dismiss + doctor tip (16.7); **persists** via server last-error beside the lock, dismiss clears server-side | Installed ✓ flip + Installed tab shows local preview | 409 inline copy (16.3) |
| Installed tab | (server-rendered, as today) | n/a (core always present); filtered-empty = zero-results state | uninstall failure: same red stage-block grammar | card + fresh preview | uncommitted badge (16.11); crash-window folders are scanner-invisible by design (§15.2) — the gallery simply omits them, never a ghost card |
| Uninstall | card dims, "removing…" | — | red stage-block | card gone; marketplace card reverts to Install (16.6) | reference warning pre-confirm (§15.9) |

### 16.6 Cross-tab sync (D9)
Installed-ness is **derived, never asserted**: one installed-ids set in the server payload; both tabs + drawer + counts derive from it. Terminal SSE events (done / error / uninstall complete) fire `router.refresh()` — the page is already `force-dynamic`. No component-local "installed" flags.

### 16.7 Post-install affordance + author tip (D10 + D11)
The drawer's kind-aware "Use it" (§15.10) becomes an affordance: a **copyable suggested-phrase chip** ("use <id> for scene 2" — content kinds + transitions only; overlays keep the honest M6 copy, no chip) + a **ghost link** "Open a project's Assemble gate →" into the project library. Failed-install error blocks end with one dim line: *"Tip: `install.mjs doctor ./<dir>` runs this exact gate locally."*

### 16.8 Tint discipline (D12) — amends §8's "one tinted action" mechanics
Card-level Install/Update buttons are **ghost** (glass, text-labeled, button geometry — clickable without tint). The screen's **single tinted Install lives in the marketplace drawer** (16.9). One tinted action per screen now holds at any catalog size.

### 16.9 Marketplace drawer variant (D15) — catalog entries cannot use the installed drawer
Anatomy: author poster (static 9:16; kind-tone placeholder when absent) → name + `author · version · license` (mono) → description + tags → **the tinted Install** with the §15.6 trust sentence directly beside it → homepage link → dim note: *"Props and live preview appear after install."* **Trust-copy placement is fixed: dropzone/overlay + this drawer only — never per-card** (amends §8's "every third-party Install" implication; wording stays §15.6 verbatim).

### 16.10 Uninstall surface (D13) — no modal primitive in v1
Uninstall lives **only in the installed-template drawer** as a danger zone: "Uninstall…" expands in place → §15.9 consequence copy verbatim + project-reference count → `danger` Button + ghost Cancel. Card feet carry no uninstall affordance; core templates show a dim "core — protected" hint. Escape/backdrop/focus semantics inherited from `TemplateDrawer`.

### 16.11 Uncommitted badge (D14)
A dim per-card **"uncommitted"** Badge on installed cards, derived server-side from `git status --porcelain templates/<id>` — appears from ground truth, self-clears on commit, zero dismissal machinery. No banner. The install success drawer mentions it once ("on disk, not yet committed").

### 16.12 Responsive contract (D16)
Below `lg`: the drag overlay never arms (no drag on touch); the **file-picker button is the universal install path**; toolbar wraps to two rows (tabs+counts / search) with pills in one horizontally scrollable row; grid stays 2-col; tap = drawer (as today). **Declared state: no hover-preview on touch** — poster + drawer playback is the mobile preview story. All pills/controls get ≥44px hit areas via padding (visual size unchanged).

### 16.13 Accessibility contract (D17 + D19)
`aria-live="polite"` on the install stage label (assertive for terminal done/error); tab bar uses the tablist keyboard pattern (arrow keys, no focus loss on panel swap); the drag overlay is mouse-only **because** the file-picker button is the keyboard/SR-equivalent path (stated); **`:focus-visible` rings (token: `--glass-border-active`) on all new controls AND the existing gallery pills/cards** (D19 fold-in — pays down the latent gap while M4 has those files open); reduced-motion collapses the checklist pulse (globals.css already enforces; stated so nobody exempts it).

### 16.14 M4 gate additions (extends §11 M4)
Motion clips grow: (e) update flow — catalog newer version → Update button → confirm → re-render; (f) **keyboard-only walkthrough** (tab through tabs/search/pills/cards, install via file picker, read stage announcements); (g) one **sub-`lg` viewport clip/screenshot** of the wrapped toolbar + file-picker install path. Header count semantics (16.2) verified in (a).

### 16.15 Engine deltas created by this section (M2 must know)
(1) SSE helper keep-alive-on-disconnect mode for installs (16.3); (2) last-error persisted beside the install lock, cleared by dismiss (16.5); (3) same-version-replace confirm path + fixture, §12 → 29 (16.4); (4) the state endpoint serves installed-ids + per-id uncommitted-ness + last-error (16.6, 16.11). All four are M2 scope consumed by M4 — listed here so M0 re-grounding carries them into the task plan.

---

## Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| /templates M4 surface (both tabs + 6 states) | `~/.gstack/projects/zainaliazmat-AI-Video-Generation-Tool/designs/templates-marketplace-20260612/wireframe.html` | Token-true Liquid Glass wireframe (Regular glass, DM Sans/Mono, content-card grid) | Approved D3; amended per D7/D12/D13/D14 and re-synced (D18). `approved.json` records the ruling trail. Designer binary lacked an OpenAI key — HTML-wireframe fallback chosen deliberately (D2). |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | ABSORBED (Claude outside voices) | Eng: 14 findings, 13 accepted into §15, 1 rejected (M3 held per D2/D17). Design: 15 findings, all absorbed into §16 [single-model] |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 9 issues, 0 open critical gaps — ratified into §15; §12 at 28 fixtures (→ **29** per §16.4) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN) | score: 6/10 → 9/10, 15 decisions (D5–D19) ratified into §16; wireframe approved + synced |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CROSS-MODEL:** Eng cycle — one genuine tension (M3 ceremony argument; operator held scope, D17-eng). Design cycle — outside voice (Claude subagent, fresh context) challenged three D3 wireframe rulings; operator re-ruled all three in the voice's favor (D12 ghost installs, D13 drawer danger zone, D14 derived badge) and confirmed the rest. Both cycles' voices extended rather than contradicted the primary reviews.
- **VERDICT:** ENG + DESIGN CLEARED — plan LOCKED; §15 (eng) + §16 (design) amendments normative; all §14 decisions ruled. §16.15's four engine deltas ride the M0 re-grounding into the task plan. Ready to implement when the M0 build slot opens (after Studio-v2 merge gates clear + re-grounding per §15.12).

NO UNRESOLVED DECISIONS
