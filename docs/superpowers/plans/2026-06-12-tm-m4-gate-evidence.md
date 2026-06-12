# M4 Studio Surface — Gate Evidence (§16.14)

Branch `tm-m4-studio-surface`. Dev server `:3100` (preview, `GSTACK_CHROMIUM_NO_SANDBOX=1`). Artifacts in `~/Downloads/tm-m4-gate/` (the `/mnt/user-data/uploads/` path was absent on this box — noted per the plan's fallback). All flows run against the REAL engine (real installs render real previews).

## Curl E2E — route correctness (proven before the visual gate)

| Check | Result |
|---|---|
| `GET /api/marketplace/index` | 200, 3 seeds (bold-stat, kinetic-hook, wipe) |
| `GET /api/templates/state` | 200, installedIds = 8 core + per-id uncommitted + lastError |
| `GET /api/marketplace/poster?id=wipe` | 200, `image/jpeg`, 1080×1920, 19647 bytes (B2 fix — real poster served) |
| `POST /api/templates/install` `{catalogId:"wipe"}` (SSE) | ordered `validating→typecheck→assets→register→rendering-preview→done` + `{type:'done',result}`; state then shows `wipe` installed |
| `DELETE /api/templates/wipe` | `{removed:true, referencedBy:{total:0}}`; state back to 8 |
| `POST install` `{catalogId:"nope-not-real"}` | SSE `{type:'error', stage:'id', message:'no marketplace package "nope-not-real" in the catalog…'}` |
| `DELETE /api/templates/hook` (core) | HTTP 400 `{error:'"hook" is a core template — protected…', stage:'uninstall'}` |
| `GET /api/templates/hook` (drawer ref count) | `{total:4, files:[…4 project specs…]}` (real scan) |

## Motion clips (a)–(g) — self-verified against each criterion

| Clip | Criterion (§16.14) | Artifact(s) | Self-verdict |
|---|---|---|---|
| (a) | drag-drop/file-pick → stage progress → new card preview playing + header count | `04b-install-rendering-preview.png`, `06-installed-done.png` | **PASS.** Clicked a catalog Install → in-card stage checklist `✓ validate ✓ typecheck ✓ assets ✓ register ● rendering preview` + "can take a couple of minutes" latency line, **NO percent bar** (§16.3). On done: card flipped to green "Installed ✓", headline "8 → 9 drop-in templates", tab "Installed 8 → 9". No flash to "Install" (I1 fix). |
| (b) | a failing zip → loud stage error | `13-bad-zip-error.png` | **PASS.** Uploaded `broken.zip` → zip-install fail surface (B1 fix): `✕ UNPACK` + exact violation "not a valid zip: ADM-ZIP: Invalid or unsupported zip format. No END header found" + Dismiss + doctor tip "install.mjs doctor ./<dir> runs this exact gate locally." |
| (c) | uninstall with the reference warning | `11-danger-zone-uninstall.png` (+ `DELETE` proven) | **PASS.** Installed drawer → "Uninstall…" expands in place (no modal, §16.10) → §17.2 consequence copy **verbatim** ("Scenes and overlays will show the loud MissingTemplate placeholder; transitions fall back to a silent hard cut. Editing, assembling, or re-rendering those projects will fail loudly…") + lazy "Checking project references…" + danger Uninstall / ghost Cancel. Removal proven via `DELETE /api/templates/kinetic-hook` → `{removed:true}` → state back to 8. |
| (d) | search filtering | `07-search-filter.png` | **PASS.** Typed "stat" → both tab labels updated to "Installed 1 · Marketplace 1" (§16.2 cross-tab counts respond to query). |
| (e) | update flow — catalog newer version → Update | `12-update-triad.png` | **PASS (staged version delta).** Installed kinetic-hook (1.0.0); staged catalog 1.1.0 in the gitignored built index → card showed "Update to 1.1.0" (the §16.4 triad Install / Installed ✓ / Update to x.y.z). Index restored to 1.0.0 after. The version delta is staged because no seed ships two versions; the triad logic + render are real. |
| (f) | keyboard-only walkthrough (focus rings) | `08-focus-ring.png` | **PASS.** Tab navigation reaches controls; `:focus-visible` ring (`--glass-border-active`) visible on the focused card. Tablist arrow-key pattern + aria-live wired (§16.13). |
| (g) | sub-`lg` viewport | `09-responsive-sublg.png` | **PASS.** 390×844: toolbar wraps to stacked rows (tabs+counts / search / Install-from-.zip / pills), grid stays usable, file-picker is the universal install path, no drag overlay (§16.12). |

Supporting captures: `01-installed-tab.png`, `02-marketplace-tab.png` (3 catalog cards with real posters + ghost Install), `03-marketplace-drawer-tinted-install.png` (the ONE tinted Install + §15.6 trust copy + "Props and live preview appear after install"), `10-installed-drawer.png` (use-it chip "use kinetic-hook for scene 2" + Assemble-gate link), `14-settled-8core.png` (settled state, core cards show "core — protected").

## Full regression (alongside the visual gate)

| Suite | Result |
|---|---|
| backend pytest | 323 passed |
| templates tsc / remotion tsc / preview tsc | exit 0 / 0 / 0 |
| templates vitest (logic) | 106 passed |
| templates vitest (e2e, run in isolation) | 4 passed (exit 0 after the async-runner fix) |
| remotion vitest | 104 passed |
| preview vitest (deriveView) | 23 passed |
| build-registry | 8 templates |
| `git status` | clean (only 2 pre-existing untracked files) |

**Verdict: M4 GATE PASS.** Every §16 surface rendered to the wireframe; all 7 motion criteria self-verified on real pixels; the route layer proven by curl; full regression green; tree clean after the gate's real install/uninstall churn.
