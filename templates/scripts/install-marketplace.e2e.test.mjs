// Task 5: M3 gate — install-from-catalog e2e on a real seed.
// Uses DEFAULT runners (real tsc + real render + sha256 verify) against the
// committed `wipe` seed (smallest — a transition, fastest render ~30-45s).
// Timeout: 900_000ms (15 min) per the plan.

import {mkdirSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {
  installFromMarketplace,
  uninstall,
  TEMPLATES_DIR,
  RENDER_ASSETS_DIR,
  PREVIEWS_DIR,
  REPO_ROOT,
} from './install.mjs';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const repoRoot = resolve(templatesDir, '..');
const buildIndexScript = join(__dirname, 'build-marketplace-index.mjs');
const buildRegistryScript = join(__dirname, 'build-registry.mjs');

// The smallest seed — a transition, fastest render.
const SEED_ID = 'wipe';

/** Restore the tree to 8-template baseline. */
async function cleanup() {
  if (existsSync(join(TEMPLATES_DIR, SEED_ID))) {
    try {
      await uninstall(SEED_ID);
    } catch {
      // force-remove if uninstall fails (e.g. already mid-cleanup)
    }
    // belt-and-braces: force-remove any remnants
    rmSync(join(TEMPLATES_DIR, SEED_ID), {recursive: true, force: true});
    rmSync(join(RENDER_ASSETS_DIR, SEED_ID), {recursive: true, force: true});
    rmSync(join(PREVIEWS_DIR, `${SEED_ID}.mp4`), {force: true});
    rmSync(join(PREVIEWS_DIR, `${SEED_ID}.jpg`), {force: true});
  }
  execFileSync('node', [buildRegistryScript], {stdio: 'pipe'});
}

beforeAll(async () => {
  // Ensure zips are built (gitignored; may be missing on fresh checkout).
  execFileSync('node', [buildIndexScript], {stdio: 'pipe'});
  // Clean up any residue from a previous failed run.
  await cleanup();
}, 60_000);

afterAll(async () => {
  await cleanup();
}, 60_000);

describe('install-from-catalog e2e (wipe seed, real runners)', () => {
  it(
    'installFromMarketplace(wipe) with default runners: installs, renders, python load_catalog includes it; then uninstall cleans up',
    async () => {
      // --- INSTALL ---
      const result = await installFromMarketplace(SEED_ID);

      // templates/wipe must exist
      expect(existsSync(join(TEMPLATES_DIR, SEED_ID))).toBe(true);

      // registry.generated.ts must contain it
      const reg = join(templatesDir, 'registry.generated.ts');
      expect(existsSync(reg)).toBe(true);
      expect(readFileSync(reg, 'utf8')).toContain(JSON.stringify(SEED_ID));

      // preview files must exist (mp4 + jpg)
      expect(existsSync(join(PREVIEWS_DIR, `${SEED_ID}.mp4`))).toBe(true);
      expect(existsSync(join(PREVIEWS_DIR, `${SEED_ID}.jpg`))).toBe(true);

      // python load_catalog must include it
      const pyCheck = [
        '-c',
        `from pipeline.validate import load_catalog; from pathlib import Path; ` +
          `c = load_catalog(Path(${JSON.stringify(repoRoot)}) / "templates"); ` +
          `assert ${JSON.stringify(SEED_ID)} in c, f"wipe missing; got: {sorted(c)}"`,
      ];
      execFileSync(
        join(repoRoot, 'backend', '.venv', 'bin', 'python'),
        pyCheck,
        {cwd: join(repoRoot, 'backend'), stdio: 'pipe'},
      );

      // install result shape
      expect(result.id).toBe(SEED_ID);

      // --- UNINSTALL ---
      const unResult = await uninstall(SEED_ID);
      expect(unResult.removed).toBe(true);

      // templates/wipe must be gone
      expect(existsSync(join(TEMPLATES_DIR, SEED_ID))).toBe(false);

      // registry must be back to 8 (no wipe)
      const regAfter = readFileSync(reg, 'utf8');
      expect(regAfter).not.toContain(JSON.stringify(SEED_ID));

      // preview files must be gone
      expect(existsSync(join(PREVIEWS_DIR, `${SEED_ID}.mp4`))).toBe(false);
      expect(existsSync(join(PREVIEWS_DIR, `${SEED_ID}.jpg`))).toBe(false);
    },
    900_000,
  );
});
