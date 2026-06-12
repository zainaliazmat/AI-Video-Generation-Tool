# M5 Authoring Kit — Gate Evidence

Branch `tm-m5-authoring-kit`. Artifacts in `~/Downloads/tm-m5-gate/` (`/mnt/user-data/uploads/` absent on this box — noted per the plan fallback). Zero LLM/Tavily/Pexels spend.

## M5 GATE (code) — scaffold-passes-doctor CI test

`templates/scripts/new-template.test.mjs` runs the REAL `doctor()` (no runner stubs → real tsc + preview render + import-lint + guaranteed rollback) on a freshly-scaffolded template:
- `--kind scene` → `{ok:true, id:'scaffold-scene-test', kind:'scene'}` (~36s)
- `--kind transition` → `{ok:true, id:'scaffold-transition-test', kind:'transition'}` (~37s)

The scaffold passes the install gate untouched — the standard's executable example. Test suite total: **119 passed** (9 files).

## M5 GATE (clean-room) — the workstream E2E closer

A third-party-shaped template authored from scratch and carried through the entire lifecycle. Each step run for real:

| Step | Command / action | Result |
|---|---|---|
| 1. scaffold | `node templates/scripts/new-template.mjs --id clean-room-demo --kind stat --dir /tmp/m5-cleanroom` | wrote `clean-room-demo/{manifest.json, schema.ts, Component.tsx, README.md}` + next-steps |
| 2. small edit | sampleProps `title` → "Clean-room proof" (a real author tweak) | valid |
| 3. doctor | `install.mjs doctor /tmp/m5-cleanroom/clean-room-demo` | `[doctor] OK: clean-room-demo v1.0.0 (stat) is installable` (real tsc + render + import-lint, rolled back) |
| 4. pack | `install.mjs pack … --out /tmp/m5-cleanroom` | `[pack] doctor OK — packed clean-room-demo v1.0.0 → …zip` (2758 B, unzips to a single `clean-room-demo/` folder) |
| 5. install via the M4 surface | `POST /api/templates/install` multipart with the packed zip | SSE `validating→typecheck→assets→register→rendering-preview→done`; state then includes `clean-room-demo`; preview mp4+jpg rendered (`installed-card.png`) |
| 6. switch onto a real video via the Assemble seam | swapped `scene-4` (a stat slot) of project `auto-09ca…` to `clean-room-demo`; `validate_spec(spec, catalog)` | **OK** — clean-room-demo accepted as a legal stat-slot template; this is the exact catalog check the Assemble gate (`spec_patch` whitelist `scenes[i].template`) runs before applying. Zero LLM spend (deterministic validation path, the same seam Assemble chat writes to). |
| 7. rendered frame on a real scene | `remotion still Video … --frame=600` (inside scene-4: frames 540–746) on the swapped spec | `scene4-clean-room.png` — clean-room-demo paints in the project's real Video composition: "Clean-room proof" headline in the project foreground color + a yellow accent underline (the project's `accent` theme token) on the project background. **Self-verdict: PASS** — the authored-from-scratch template renders correctly on a real project scene with the real theme. |

Cleanup: uninstalled clean-room-demo, removed the temp project, restored the staged spec → `git status` clean, `build-registry` → 8 core, no residue.

Artifacts: `~/Downloads/tm-m5-gate/installed-card.png` (gallery after install), `~/Downloads/tm-m5-gate/scene4-clean-room.png` (the rendered frame on scene-4).

## Full regression

| Suite | Result |
|---|---|
| backend pytest | (see final report) |
| 3× tsc | exit 0 each |
| templates vitest (logic) | 119 passed |
| templates vitest (e2e isolated) | passed |
| remotion vitest | passed |
| preview vitest | passed |
| build-registry | 8 |
| git status | clean |

**Verdict: M5 GATE PASS.** Code gate (scaffold-passes-doctor) green; clean-room gate closes the loop end-to-end — scaffold → edit → doctor → pack → install through the real Studio surface → accepted by the Assemble seam onto a real video → rendered on a real scene. The authoring kit produces installable, usable templates without the author reading our source.
