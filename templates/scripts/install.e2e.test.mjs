// install.e2e.test.mjs — REAL end-to-end pipeline proofs (§12).
//
// NO stubbed runners for the core tests — real tsc, real Remotion preview render,
// real rollback. Tests publish into the live tree and clean up after themselves.
//
// Timeouts: 900_000 ms per test (real renders can take 1–3 min).
// fileParallelism: false (set in vitest.config.mjs — never run these in parallel).

import {existsSync, readFileSync, writeFileSync, rmSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {afterEach, afterAll, describe, expect, it} from 'vitest';
import {
  install, uninstall, installedState,
  TEMPLATES_DIR, RENDER_ASSETS_DIR, PREVIEWS_DIR, SCRIPTS_DIR,
} from './install.mjs';
import {zipFixture} from './fixtures/helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const repoRoot = resolve(templatesDir, '..');

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIX       = join(__dirname, 'fixtures', 'valid-scene');       // fixture-card
const VALID_TRANSITION = join(__dirname, 'fixtures', 'valid-transition'); // fixture-wipe
const TSC_ERROR = join(__dirname, 'fixtures', 'tsc-error');         // fixture-tsc-error
const THROWS    = join(__dirname, 'fixtures', 'throws-at-render');  // fixture-throws

// ---------------------------------------------------------------------------
// expectStage helper (mirrors logic suite)
// ---------------------------------------------------------------------------

/** Assert that a promise rejects with an InstallError at the expected stage. */
const expectStage = async (promise, stage, msgPart) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err, 'expected a rejection').toBeTruthy();
  expect(err.stage).toBe(stage);
  if (msgPart) expect(err.message).toContain(msgPart);
};

// ---------------------------------------------------------------------------
// Cleanup helper — restores tree to pre-test state
// ---------------------------------------------------------------------------

const FIXTURE_IDS = ['fixture-card', 'fixture-wipe', 'fixture-tsc-error', 'fixture-throws'];

async function cleanFixtures() {
  for (const id of FIXTURE_IDS) {
    rmSync(join(TEMPLATES_DIR, id), {recursive: true, force: true});
    rmSync(join(RENDER_ASSETS_DIR, id), {recursive: true, force: true});
    rmSync(join(PREVIEWS_DIR, `${id}.mp4`), {force: true});
    rmSync(join(PREVIEWS_DIR, `${id}.jpg`), {force: true});
    // Mirror assets in preview/public/template-assets/
    rmSync(join(repoRoot, 'preview', 'public', 'template-assets', id), {recursive: true, force: true});
  }

  // Drop any fixture lock entries from previews.lock.json
  const lockPath = join(PREVIEWS_DIR, 'previews.lock.json');
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      for (const id of FIXTURE_IDS) delete lock[id];
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    } catch { /* tolerate */ }
  }

  // Restore registry to 8 core templates
  execFileSync('node', [join(SCRIPTS_DIR, 'build-registry.mjs')], {stdio: 'pipe'});
}

afterEach(cleanFixtures);
afterAll(cleanFixtures);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read registry.generated.ts and return true if `id` appears in it. */
function registryContains(id) {
  const reg = join(templatesDir, 'registry.generated.ts');
  if (!existsSync(reg)) return false;
  return readFileSync(reg, 'utf8').includes(JSON.stringify(id));
}

// ---------------------------------------------------------------------------
// Test 1: valid-scene full install → preview rendered → uninstall clean (asset-bearing render proof)
// ---------------------------------------------------------------------------

describe('E2E: valid-scene full install + uninstall (asset-bearing render proof)', () => {
  it(
    'install with default runners → mp4+jpg rendered, dot.png shipped+mirrored, Python catalog includes it, uninstall cleans up completely',
    {timeout: 900_000},
    async () => {
      // --- INSTALL ---
      const r = await install(FIX);

      // Result shape
      expect(r.id).toBe('fixture-card');
      expect(r.version).toBe('1.0.0');
      expect(r.kind).toBe('scene');
      expect(r.updated).toBeNull();
      expect(r.preview).toContain('fixture-card');

      // Registry updated
      expect(registryContains('fixture-card')).toBe(true);

      // Preview files exist (real render proof)
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-card.mp4')), 'fixture-card.mp4 must exist').toBe(true);
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-card.jpg')), 'fixture-card.jpg must exist').toBe(true);

      // Assert mp4 is non-trivial (a real Remotion render; not a zero-byte or tiny stub)
      const mp4Stat = statSync(join(PREVIEWS_DIR, 'fixture-card.mp4'));
      expect(mp4Stat.size, 'mp4 must be > 10 KB (real render, not a stub)').toBeGreaterThan(10_000);

      // Declared asset shipped to remotion/public/template-assets/fixture-card/
      expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card', 'dot.png')), 'dot.png in RENDER_ASSETS_DIR').toBe(true);
      expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card', 'CREDITS.json')), 'CREDITS.json in RENDER_ASSETS_DIR').toBe(true);

      // Mirror asset in preview/public/template-assets/fixture-card/
      expect(existsSync(join(repoRoot, 'preview', 'public', 'template-assets', 'fixture-card', 'dot.png')), 'dot.png mirrored into preview/public').toBe(true);

      // Python catalog includes fixture-card (load_catalog takes templates_dir)
      execFileSync(
        join(repoRoot, 'backend', '.venv', 'bin', 'python'),
        [
          '-c',
          [
            'import pathlib',
            'from pipeline.validate import load_catalog',
            `templates_dir = pathlib.Path(${JSON.stringify(join(repoRoot, 'templates'))})`,
            'c = load_catalog(templates_dir)',
            'assert "fixture-card" in c, "fixture-card not in catalog: " + str(sorted(c))',
          ].join('; '),
        ],
        {cwd: join(repoRoot, 'backend'), stdio: 'pipe'},
      );

      // lastError cleared
      expect(installedState().lastError).toBeNull();

      // --- UNINSTALL ---
      const u = await uninstall('fixture-card');
      expect(u.removed).toBe(true);

      // Template folder gone
      expect(existsSync(join(TEMPLATES_DIR, 'fixture-card')), 'template dir must be gone after uninstall').toBe(false);

      // Registry no longer contains fixture-card
      expect(registryContains('fixture-card')).toBe(false);

      // Preview files gone
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-card.mp4')), 'mp4 must be gone after uninstall').toBe(false);
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-card.jpg')), 'jpg must be gone after uninstall').toBe(false);

      // Assets gone from RENDER_ASSETS_DIR
      expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card')), 'RENDER_ASSETS_DIR/fixture-card must be gone').toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 2: valid-transition installs via presentation.tsx path (genPreviews stubbed)
// ---------------------------------------------------------------------------

describe('E2E: valid-transition installs via presentation.tsx path', () => {
  it(
    'install kind=transition, real tsc + real registry, stubbed genPreviews, result.kind=transition, registry has type:transition',
    {timeout: 900_000},
    async () => {
      // Stub genPreviews only (transition preview rendering already proven by core fade/slide)
      const result = await install(zipFixture(VALID_TRANSITION), {
        runners: {
          genPreviews: () => { /* stub — transition preview already proven */ },
        },
      });

      expect(result.kind).toBe('transition');
      expect(result.id).toBe('fixture-wipe');

      // Registry contains fixture-wipe with type: 'transition'
      const regText = readFileSync(join(templatesDir, 'registry.generated.ts'), 'utf8');
      expect(regText).toContain('"fixture-wipe"');
      expect(regText).toContain("type: 'transition'");

      // Uninstall — defaults fine (no preview render on uninstall)
      const u = await uninstall('fixture-wipe');
      expect(u.removed).toBe(true);

      expect(existsSync(join(TEMPLATES_DIR, 'fixture-wipe'))).toBe(false);
      expect(registryContains('fixture-wipe')).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 3: tsc-error — REAL stage-6 reject + rollback
// ---------------------------------------------------------------------------

describe('E2E: tsc-error — REAL stage-6 reject + rollback', () => {
  it(
    'tsc type error causes stage=typecheck rejection, template dir absent, registry byte-identical',
    {timeout: 900_000},
    async () => {
      // Snapshot registry text before
      const regBefore = readFileSync(join(templatesDir, 'registry.generated.ts'), 'utf8');

      // Should reject at stage=typecheck with a TS error indicator
      await expectStage(
        install(zipFixture(TSC_ERROR)),
        'typecheck',
        'TS',
      );

      // Template dir must be gone (rollback)
      expect(existsSync(join(TEMPLATES_DIR, 'fixture-tsc-error')), 'template dir must be rolled back').toBe(false);

      // Registry text unchanged (never registered)
      const regAfter = readFileSync(join(templatesDir, 'registry.generated.ts'), 'utf8');
      expect(regAfter).toBe(regBefore);
      expect(registryContains('fixture-tsc-error')).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 4: throws-at-render — REAL stage-7 reject + rollback
// ---------------------------------------------------------------------------

describe('E2E: throws-at-render — REAL stage-7 reject + rollback', () => {
  it(
    'component throws at render time causes stage=preview rejection, template dir absent, registry rebuilt without it',
    {timeout: 900_000},
    async () => {
      await expectStage(
        install(zipFixture(THROWS)),
        'preview',
      );

      // Template dir must be gone (rollback)
      expect(existsSync(join(TEMPLATES_DIR, 'fixture-throws')), 'template dir must be rolled back').toBe(false);

      // Registry rebuilt without fixture-throws
      expect(registryContains('fixture-throws')).toBe(false);

      // No stale preview file
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-throws.mp4')), 'preview mp4 must be absent').toBe(false);
    },
  );
});
