# Template Marketplace — Merged Ordered Build Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the template marketplace per the locked spec (`template-marketplace-plan.md`, §15 eng + §16 design normative, §17 M0 addendum) — manifest v1.1, installer pipeline, local store, Studio surface, authoring kit.

**Architecture:** The marketplace is seams, not a subsystem: package format = the template folder zipped; installer = validate→stage→typecheck→register→smoke-render, fails closed, atomic (§15.2 ordering); catalog = `marketplace/index.json` behind `MarketplaceSource`; Studio surface extends `/templates` per the approved wireframe. Nothing in the render path, spec contract, audio math, or recipe changes.

**Tech Stack:** Pydantic v2 (manifest source of truth) + generated JSON Schema; Node .mjs scripts (installer/codegen, matching `build-registry.mjs` idiom); Next.js App Router SSE routes (donor: `render/route.ts`); Remotion previews; vitest + pytest.

**This document merges** `tasks-eng-review-20260612-025114.jsonl` (T1–T14) and `tasks-design-review-20260612-035210.jsonl` (T1–T12) into one milestone order. Eng tasks are cited `E-T<n>`, design tasks `D-T<n>`. The four §16.15 engine deltas are explicit M2 scope. Where this doc and the spec conflict, the spec (§15/§16/§17) wins.

**Visual reference for M4 (open BOTH):**
- `~/.gstack/projects/zainaliazmat-AI-Video-Generation-Tool/designs/templates-marketplace-20260612/wireframe.html`
- `~/.gstack/projects/zainaliazmat-AI-Video-Generation-Tool/designs/templates-marketplace-20260612/approved.json` (ruling trail D3, D5–D19)

---

## Milestone order & lanes

```
M0 (DONE) → M1 → M2 → ┬─ M3 (store+seam+seeds) ─┬→ M4 (Studio surface)
                      └─ M5 (authoring kit) ─────┘
```

- **M1 → M2 strictly sequential** (M2's installer validates against M1's generated schema; M2's resolver feeds every later smoke render).
- **M3 ∥ M5 may run as parallel lanes** — ⚠️ **LANE CONFLICT on `templates/scripts/`**: M3 adds `build-marketplace-index.mjs` + a `--from-marketplace` entry in `install.mjs`; M5 adds `new-template.mjs` + `pack-template` + the doctor import-lint **inside `install.mjs`**. `install.mjs` is shared. Rule: **all `install.mjs` edits land in one lane at a time** — run M3's installer edits first, M5's doctor-lint second (or run the milestones sequentially; both fit the slot). New-file work (`build-marketplace-index.mjs`, `new-template.mjs`, `TEMPLATE-AUTHORING.md`) is conflict-free.
- **M4 last**: consumes M2's engine deltas (§16.15), M3's catalog, and M5's doctor tip copy. M5's clean-room gate (drag-drop install → gallery → Assemble → render) needs M4's surface, so M5's *gate* closes after M4 even if M5's *code* lands earlier.
- **Per-milestone expansion (house rhythm):** M1 is expanded to bite-sized TDD tasks below and builds now. M2–M5 are scoped at task granularity here (files + gates + normative spec refs — the spec carries the stage diagrams, exact copy strings, and the 29-fixture matrix) and each gets its bite-sized expansion when its slot opens, exactly as §15.12 did for M0. Operator gates sit between milestones; do not build ahead of the gate.

---

## M0 — Re-grounding (DONE 2026-06-12)

E-T14. Plan committed as spec (d967a8b); §17 addendum records the deltas; this document is the merged task plan. Key resolved items the later milestones MUST honor: root-spec scan is REAL (§17.1), transition fallback is silent hard-cut — copy adjusted (§17.2), explicit dot-skip rides T3 (§17.4), core backfill omits `license` (§17.7).

---

## M1 — Manifest v1.1 + the third validator (BUILDS NOW)

Maps: **E-T1**. Gate: backend tests green incl. lockstep tests; `build-registry`/`gen-manifests` byte-stable on unchanged inputs.

### Task 1: Pydantic manifest v1.1 — additive fields + `extra="forbid"`

**Files:**
- Modify: `backend/manifest.py`
- Test: `backend/tests/test_manifest.py` (extend)

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_manifest.py`:

```python
def test_v11_fields_parse_and_default_none():
    m = Manifest.model_validate({
        **_valid(),
        "description": "Word-cascade opening title.",
        "tags": ["hook", "kinetic"],
        "license": "MIT",
        "homepage": "https://example.com",
        "assets": ["assets/underline.svg"],
    })
    assert m.description == "Word-cascade opening title."
    assert m.tags == ["hook", "kinetic"]
    assert m.license == "MIT"
    assert m.homepage == "https://example.com"
    assert m.assets == ["assets/underline.svg"]


def test_v11_fields_all_optional():
    m = Manifest.model_validate(_valid())
    assert m.description is None
    assert m.tags is None
    assert m.license is None
    assert m.homepage is None
    assert m.assets is None


def test_unknown_envelope_field_rejected():
    # extra="forbid" (§15.13): unknown keys hard-fail instead of silently passing.
    with pytest.raises(ValidationError):
        Manifest.model_validate({**_valid(), "surprise": True})


def test_unknown_duration_frames_field_rejected():
    bad = _valid()
    bad["durationFrames"] = {"min": 30, "max": 120, "step": 1}
    with pytest.raises(ValidationError):
        Manifest.model_validate(bad)
```

- [ ] **Step 2: Run to verify failure** — `cd backend && .venv/bin/python -m pytest tests/test_manifest.py -q` → the two `*_rejected` tests FAIL (no error raised) and `test_v11_fields_parse_and_default_none` FAILS (forbid absent today means extras pass silently, but `m.description` raises AttributeError).
- [ ] **Step 3: Implement** in `backend/manifest.py` — add `ConfigDict` import and the fields (comments mirror §4.2; lockstep discipline noted):

```python
from pydantic import BaseModel, ConfigDict


class DurationFrames(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min: int
    max: int


class Manifest(BaseModel):
    # The envelope is strict (§15.13): an unknown key is a stale or malformed
    # package, never something to ignore. MUST stay in lockstep with
    # templates/sdk.ts and the generated templates/manifest.schema.json.
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    version: str
    author: str
    apiVersion: str
    kind: TemplateKind
    inputSchema: dict
    sampleProps: dict
    durationFrames: DurationFrames
    rendersOwnText: bool = False
    consumes: Optional[str] = None
    # --- v1.1 additive fields (§4.2) — all optional at the envelope level.
    # license is required for non-core authors by the IMPERATIVE pass (§15.13),
    # which lives installer-side (M2), not in this schema validator.
    description: Optional[str] = None     # catalog/search text
    tags: Optional[list[str]] = None      # search facets
    license: Optional[str] = None         # SPDX id
    homepage: Optional[str] = None        # author link in the drawer
    assets: Optional[list[str]] = None    # declared relative paths under assets/
```

(Keep the existing field comments for `rendersOwnText`/`consumes` verbatim — only the lines shown change/append.)
- [ ] **Step 4: Run the full backend suite** — `cd backend && .venv/bin/python -m pytest tests/ -q` → expected: all green (317 collected today; fixtures all conform to the envelope, so forbid breaks nothing — if any test asserted unknown-fields-ignored, fix that test, it asserted the §15.13 bug).
- [ ] **Step 5: Commit** — `git add backend/manifest.py backend/tests/test_manifest.py && git commit -m "feat(manifest): v1.1 additive fields + strict envelope (extra=forbid) — §4.2/§15.13"`

### Task 2: Generated `templates/manifest.schema.json` + drift check

**Files:**
- Create: `backend/gen_manifest_schema.py`
- Create: `templates/manifest.schema.json` (generated, committed)
- Test: `backend/tests/test_manifest_schema.py`

- [ ] **Step 1: Write the failing drift test** — `backend/tests/test_manifest_schema.py`:

```python
"""The third validator must never drift (§4.2): templates/manifest.schema.json
is GENERATED from the Pydantic Manifest (the source of truth) and committed.
This test IS the CI diff check — it fails when the committed file is stale."""
import pathlib

from gen_manifest_schema import SCHEMA_PATH, render_schema


def test_committed_schema_matches_model():
    assert SCHEMA_PATH.exists(), (
        f"{SCHEMA_PATH} missing — generate with: python backend/gen_manifest_schema.py"
    )
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render_schema(), (
        "templates/manifest.schema.json is stale — regenerate with: "
        "python backend/gen_manifest_schema.py"
    )


def test_schema_carries_strict_envelope():
    # extra="forbid" must surface as additionalProperties:false so the
    # node-side installer inherits the same strictness (§15.13).
    import json
    schema = json.loads(render_schema())
    assert schema["additionalProperties"] is False
```

- [ ] **Step 2: Run to verify failure** — `cd backend && .venv/bin/python -m pytest tests/test_manifest_schema.py -q` → FAIL: `ModuleNotFoundError: gen_manifest_schema`.
- [ ] **Step 3: Implement** `backend/gen_manifest_schema.py`:

```python
"""Generate templates/manifest.schema.json from the Pydantic Manifest model.

The regenerate-and-diff pattern gen-manifests already uses: Pydantic is the
source of truth; the committed JSON Schema is the node-side installer's
validator; tests/test_manifest_schema.py is the drift check.

Usage:
    python backend/gen_manifest_schema.py           # (re)write the file
    python backend/gen_manifest_schema.py --check   # exit 1 on drift
"""
import json
import sys
from pathlib import Path

from manifest import Manifest

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "templates" / "manifest.schema.json"


def render_schema() -> str:
    return json.dumps(Manifest.model_json_schema(), indent=2) + "\n"


def main() -> int:
    text = render_schema()
    if "--check" in sys.argv[1:]:
        on_disk = SCHEMA_PATH.read_text(encoding="utf-8") if SCHEMA_PATH.exists() else ""
        if on_disk != text:
            print(f"[gen-manifest-schema] DRIFT: {SCHEMA_PATH} is stale — "
                  f"regenerate with: python backend/gen_manifest_schema.py", file=sys.stderr)
            return 1
        print("[gen-manifest-schema] up to date")
        return 0
    SCHEMA_PATH.write_text(text, encoding="utf-8")
    print(f"[gen-manifest-schema] wrote {SCHEMA_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Generate the file** — `cd backend && .venv/bin/python gen_manifest_schema.py` → writes `templates/manifest.schema.json`.
- [ ] **Step 5: Run the tests** — `cd backend && .venv/bin/python -m pytest tests/test_manifest_schema.py tests/test_manifest.py -q` → PASS. Also verify `--check` round-trips: `.venv/bin/python gen_manifest_schema.py --check` → "up to date", exit 0.
- [ ] **Step 6: Commit** — `git add backend/gen_manifest_schema.py backend/tests/test_manifest_schema.py templates/manifest.schema.json && git commit -m "feat(manifest): generated manifest.schema.json + drift check — the third validator (§4.2)"`

### Task 3: TS lockstep widening + core manifest backfill + byte-stability gate

**Files:**
- Modify: `templates/sdk.ts:45-73` (Manifest interface)
- Modify: all 8 `templates/<id>/manifest.json` (backfill `description` + `tags`; **no `license` on core** per §17.7)
- Test: existing suites + byte-stability checks (commands below)

- [ ] **Step 1: Widen `templates/sdk.ts`** — inside `export interface Manifest`, after `consumes?: string;`, add (lockstep comments match manifest.py):

```ts
  /** Catalog/search text (§4.2). Optional. Lockstep: backend/manifest.py. */
  description?: string;
  /** Search facets, e.g. ["numbers", "hero", "minimal"]. Optional. */
  tags?: string[];
  /** SPDX id. Required for non-core authors by the installer's imperative
   *  pass (§15.13) — optional at the envelope level. */
  license?: string;
  /** Author link, surfaced in the gallery drawer. Optional. */
  homepage?: string;
  /** Declared relative paths under assets/ the installer must ship —
   *  undeclared files are rejected (§4.2/§4.4). Optional. */
  assets?: string[];
```

- [ ] **Step 2: Backfill the 8 core manifests** — add `description` and `tags` to each `templates/<id>/manifest.json` (insert after `"kind"`; verify wording against each component before committing — these are search text, keep them honest):

| id | description | tags |
|---|---|---|
| hook | "Full-screen opening title hero card with word-synced headline reveal." | ["hook", "title", "text", "hero"] |
| scene | "Footage scene — media background for caption-led beats." | ["scene", "footage", "media"] |
| stat | "Statistic hero card with count-up number animation." | ["stat", "number", "hero"] |
| outro | "Closing call-to-action hero card with CTA pop." | ["outro", "cta", "hero"] |
| overlay | "Text overlay layer rendered above scene content." | ["overlay", "text"] |
| enumeration | "Image-as-hero enumeration — items reveal one-by-one in sync with narration." | ["enumeration", "list", "images", "sync"] |
| fade | "Cross-fade transition between scenes." | ["transition", "fade"] |
| slide | "Directional slide transition between scenes." | ["transition", "slide"] |

- [ ] **Step 3: Lockstep + catalog tests** — `cd backend && .venv/bin/python -m pytest tests/ -q` → all green (`test_load_catalog_reads_real_templates` now exercises the strict envelope against the backfilled files). `cd templates && npx tsc --noEmit -p tsconfig.json` and `cd remotion && npm run typecheck` and `cd preview && npm run typecheck` → clean.
- [ ] **Step 4: Byte-stability gate (the M1 gate's second half)** — from repo root:

```bash
node templates/scripts/build-registry.mjs && cp templates/registry.generated.ts /tmp/reg1.ts
node templates/scripts/build-registry.mjs && diff /tmp/reg1.ts templates/registry.generated.ts && echo REGISTRY-STABLE
cd templates && npx tsx scripts/gen-manifests.ts && cd .. && git diff --stat templates/*/manifest.json
# expected: REGISTRY-STABLE; gen-manifests rewrites nothing (inputSchema unchanged,
# new fields preserved — idempotent). git diff shows ONLY the Step-2 backfill edits.
cd backend && .venv/bin/python gen_manifest_schema.py --check   # still "up to date"
```

(If `npx tsx` is not how gen-manifests runs here, use the invocation `templates/scripts/build-registry.mjs:28` uses — it shells the same script; build-registry already ran it in the first command.)
- [ ] **Step 5: Run vitest (template/remotion suites)** — `cd remotion && npx vitest run` (and `cd preview && npx vitest run` if a suite exists) → green.
- [ ] **Step 6: Commit** — `git add templates/sdk.ts templates/*/manifest.json && git commit -m "feat(manifest): TS lockstep v1.1 widening + core description/tags backfill (license omitted on core — §17.7)"`

**M1 GATE (operator-visible):** backend suite green (incl. new lockstep + drift tests), all three tsc projects clean, registry byte-stable on double run, gen-manifests idempotent on backfilled manifests, `gen_manifest_schema.py --check` green.

---

## M2 — Installer core + doctor + engine deltas (expand at slot)

Maps: **E-T2…E-T9, E-T13** + design engine halves **D-T2/D-T3/D-T4 (server parts)** = the four **§16.15 deltas**. All normative detail: §6 (stages) as rewritten by §15.2 (verify-before-register diagram), §15.1/15.3/15.6/15.7/15.8/15.9/15.13, §17.1–17.4.

| # | Task | Files | Spec |
|---|---|---|---|
| 2.1 | Shared assets resolver wired into BOTH render harnesses + enumeration backfill + regression R1 (E-T2) | `remotion/src/assets.ts` (new), `remotion/src/Video.tsx:85,206`, `remotion/src/TemplatePreview.tsx:87`, `templates/enumeration/media.ts` | §15.1 |
| 2.2 | Installer core: stages 1–5 in `templates/.staging/<run-id>/` (gitignore it), verify-before-register ordering, `.installing` sentinel + `discover()` skip (+ leading-dot skip, §17.4) + startup sweep, single-flight lock + **last-error file beside the lock (§16.15-2)**, rollback, `--update` snapshot + **semver-≥-with-confirm (§16.15-3)** (E-T3) | `templates/scripts/install.mjs` (new), `templates/scripts/build-registry.mjs`, `.gitignore` | §15.2, §16.4 |
| 2.3 | Id safety: reserved set {scripts, node_modules, leading-dot}, disk-existence collision, consumes-uniqueness reject + `--override-capability` (E-T4) | `templates/scripts/install.mjs` | §15.3, §15.8 |
| 2.4 | Zip guards: slip, 50 MB compressed / 200 MB decompressed / 2000-entry caps (E-T5) | `templates/scripts/install.mjs` | §15.13 |
| 2.5 | `gen-manifests --dir` + byte-identical no-flag regression R2 (E-T6) | `templates/scripts/gen-manifests.ts` | §15.6 |
| 2.6 | `gen-previews --only <id>` force-render + whole-folder-incl-assets input hash (E-T7) | `remotion/scripts/gen-previews.mjs` | §15.2 |
| 2.7 | `copy-assets` managed `template-assets/` mirror with scoped orphan delete + regression R3 (E-T8) | `preview/scripts/copy-assets.mjs` | §15.7 |
| 2.8 | Uninstall: refuse core; reference scan over `projects/*/spec.json` **AND root `spec.json` (§17.1 — confirmed real)**; honest two-tier copy **with the §17.2 transition nuance**; remove folder + previews + lock entry + asset namespace + preview mirror (E-T9) | `templates/scripts/install.mjs` | §15.9, §17.1, §17.2 |
| 2.9 | Imperative validation pass (named): license-required-iff-non-core, CREDITS-iff-assets, undeclared-asset reject (§15.13 — deferred out of M1 by design) | `templates/scripts/install.mjs` | §15.13, §4.4 |
| 2.10 | Widened state surface the routes will serve: installed-ids + per-id uncommitted-ness (`git status --porcelain templates/<id>`) + last-error (**§16.15-4**) — engine function now, route in M4 | `templates/scripts/install.mjs` (exported pure fns) | §16.6, §16.11 |
| 2.11 | The 29-fixture vitest suite per §15.14 + §16.4 (3 mandatory regressions R1–R3 no-skip; every stage reject; rollback; sentinel; concurrency 409; determinism; update paths incl. same-version-confirm) (E-T13) | `templates/scripts/install.test.mjs` + `templates/scripts/fixtures/` | §12, §15.14, §16.4 |

**M2 GATE:** full fixture suite green; happy-path install→uninstall clean; Python `load_catalog` still loads everything; full backend suite green. **Note:** doctor = stages 1–7 with temp-register + guaranteed rollback + same lock (§15.2 honesty); SSE keep-alive-on-disconnect (**§16.15-1**) is M4's route work — M2 just guarantees the engine runs to completion/rollback independent of any client.

---

## M3 — Local store + seam + seeds (expand at slot; ∥ M5 with lane rule)

Maps: **E-T10**. Spec: §7, §15.4.

| # | Task | Files |
|---|---|---|
| 3.1 | `marketplace/packages/<id>/<version>/` SOURCE folders (reviewable; §15.4) + `build-marketplace-index.mjs`: deterministic zip (fixed mtimes, sorted entries) + sha256 at index time → `marketplace/index.json` | `templates/scripts/build-marketplace-index.mjs` (new), `marketplace/` (new) |
| 3.2 | `MarketplaceSource` seam + `LocalFolderSource` (sha256-verified `fetchPackage`) | `preview/lib/marketplace.ts` (new — consumed by M4 routes) |
| 3.3 | `install --from-marketplace <id>` CLI entry (⚠️ `install.mjs` lane) | `templates/scripts/install.mjs` |
| 3.4 | Seed 2–3 real demo packages authored as-if-third-party (`author != "core"`, license REQUIRED — e.g. a variant hook, a wipe transition) + author posters | `marketplace/packages/…` |

**M3 GATE:** index round-trip tests; deterministic-zip double-build hash stability; install-from-catalog e2e on the seeds.

## M5 — Authoring kit (expand at slot; ∥ M3 with lane rule)

Maps: **E-T12**. Spec: §9, §15.6 (frozen import surface: only `react`, `remotion`, `@remotion/transitions`, `zod`).

| # | Task | Files |
|---|---|---|
| 5.1 | `docs/TEMPLATE-AUTHORING.md` per §9.1 outline + Dependencies section (frozen import surface, named rule) | `docs/TEMPLATE-AUTHORING.md` (new) |
| 5.2 | doctor import-lint against the allowlist, names the rule on violation (⚠️ `install.mjs` lane) | `templates/scripts/install.mjs` |
| 5.3 | `new-template` scaffold (passes doctor untouched — CI test) + `pack-template` (runs doctor first) | `templates/scripts/new-template.mjs` (new), `templates/scripts/install.mjs` (pack subcommand) |

**M5 GATE (code):** scaffold-passes-doctor CI test green. **M5 GATE (clean-room, closes after M4):** scaffold → edit → doctor → pack → drag-drop install → gallery → Assemble onto a real video → rendered frames reviewed.

---

## M4 — Studio surface (expand at slot; LAST)

Maps: **E-T11 + D-T1…D-T12**. Spec: §8 as overridden by §16 (all of it); wireframe + approved.json are the visual reference. Consumes §16.15 deltas built in M2.

| # | Task | Files | Spec |
|---|---|---|---|
| 4.1 | Shared SSE-spawn helper extracted from donor `render/route.ts:66-161` + **keep-alive-on-disconnect mode (§16.15-1)**; install/uninstall/state routes (`POST /api/templates/install` multipart zip \| {catalogId}; `DELETE /api/templates/:id`; `GET /api/marketplace/index`); single-flight 409 | `preview/app/api/templates/*` (new), `preview/app/api/render/route.ts` | §15.5, §16.3 |
| 4.2 | §16.2 composition: glass tab bar (`Installed N · Marketplace M`, counts live under search), search, ghost "Install from .zip", drag-anywhere overlay (never arms < lg), kind pills, one trust line, headline=installed-only (D-T1) | `preview/components/TemplateGallery.tsx`, `preview/app/templates/page.tsx` | §16.2 |
| 4.3 | In-card stage checklist (mono rows ✓/pulse/dim, NO percent bar), latency copy, inline 409, RM-compliant pulse (D-T2) | `preview/components/TemplateCard.tsx` | §16.3 |
| 4.4 | Update triad Install/Installed✓/Update + re-drop inline confirm (same-version via confirm; downgrade reject) (D-T3) | `preview/components/TemplateGallery.tsx` | §16.4 |
| 4.5 | State matrix rows: skeletons, warm empty, index-corrupt inline error, zero-result cross-tab links, uninstall in-flight/failure, persistent last-error + server-side dismiss (D-T4) | gallery + card | §16.5 |
| 4.6 | Cross-tab sync: derived installed-ids in server payload; `router.refresh()` on terminal SSE; no local flags (D-T5) | `preview/app/templates/page.tsx` | §16.6 |
| 4.7 | Marketplace drawer variant: poster, meta mono row, THE one tinted Install + trust sentence beside it, homepage, props-after-install note (D-T6) | `preview/components/TemplateDrawer.tsx` | §16.9 |
| 4.8 | Uninstall danger zone in installed drawer (expand-in-place confirm, §15.9+§17.2 copy verbatim, danger+ghost buttons, core shows "core — protected") (D-T7) | `preview/components/TemplateDrawer.tsx` | §16.10 |
| 4.9 | Uncommitted badge (dim, derived from `git status --porcelain templates/<id>`, self-clearing) + success-drawer mention (D-T8) | card + page | §16.11 |
| 4.10 | Use-it affordance: kind-aware copyable phrase chip + ghost link → project library; doctor tip line in error blocks (D-T9) | drawer + gallery | §16.7 |
| 4.11 | Responsive contract: toolbar wrap, 44px hit areas, file-picker universal path, declared no-hover-preview on touch (D-T10) | gallery | §16.12 |
| 4.12 | A11y contract: aria-live stages, tablist keyboard pattern, `:focus-visible` rings (`--glass-border-active`) on new AND existing pills/cards/drawer (D19 fold-in — gap confirmed §17.6) (D-T11) | gallery, card, globals.css | §16.13 |

**M4 GATE (D-T12, §11-M4 + §16.14):** motion clips to `/mnt/user-data/uploads/`: (a) drag-drop → stages → new card preview playing (+ header count semantics), (b) failing zip loud stage error, (c) uninstall with reference warning, (d) search filtering, (e) update flow, (f) keyboard-only walkthrough, (g) sub-lg viewport clip. Reviewer looks and identifies independently.

---

## Standing rules (all milestones)

- Branch `template-marketplace` only; git-guard governs; push/PR/merge = operator. TDD per task; subagent-driven with per-task review (house rhythm). Spec §10 invariants are non-negotiable; §15/§16/§17 override §1–§14 on conflict. Don't re-litigate ruled decisions (D1–D23 eng, D1–D20 design).
