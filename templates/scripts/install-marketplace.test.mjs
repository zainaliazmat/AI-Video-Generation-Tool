// Task 3: install --from-marketplace test suite.
// Uses STUBBED runners (cheap) + REAL buildRegistry so registry assertions hold.
// Builds a tmp marketplace package zzz-mp-install from the valid-scene fixture,
// runs build-marketplace-index, then exercises installFromMarketplace.
import {mkdirSync, writeFileSync, rmSync, existsSync, cpSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  InstallError, installFromMarketplace, uninstall, TEMPLATES_DIR, RENDER_ASSETS_DIR, PREVIEWS_DIR,
  REPO_ROOT, _defaultRunners,
} from './install.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const repoRoot = resolve(templatesDir, '..');
const marketplaceDir = join(repoRoot, 'marketplace');
const buildIndexScript = join(__dirname, 'build-marketplace-index.mjs');
const buildRegistryScript = join(__dirname, 'build-registry.mjs');

const PKG_ID = 'zzz-mp-install';
const PKG_SRC_DIR = join(marketplaceDir, 'packages', PKG_ID, '1.0.0', PKG_ID);
const FIXTURE_SRC = join(__dirname, 'fixtures', 'valid-scene');

/** Build stubbed runners — tsc/genPreviews/copyAssets are no-ops; buildRegistry is REAL. */
function stubRunners(overrides = {}) {
  return {
    tsc: () => {},
    buildRegistry: () => {
      execFileSync('node', [buildRegistryScript], {stdio: 'pipe'});
    },
    genManifests: _defaultRunners.genManifests,
    genPreviews: (_id) => {},
    copyAssets: () => {},
    ...overrides,
  };
}

/** Read registry.generated.ts and return true if `id` appears in it. */
function registryContains(id) {
  const reg = join(templatesDir, 'registry.generated.ts');
  if (!existsSync(reg)) return false;
  return readFileSync(reg, 'utf8').includes(JSON.stringify(id));
}

/** Plant the zzz-mp-install source package into marketplace/packages/. */
function plantMarketplacePkg() {
  mkdirSync(PKG_SRC_DIR, {recursive: true});
  cpSync(FIXTURE_SRC, PKG_SRC_DIR, {recursive: true});
  // Rewrite manifest: id = zzz-mp-install, author = mp-tester, license = MIT.
  // The valid-scene fixture already has inputSchema baked — the spread preserves it.
  // Stage-5 gen-manifests runs from templates/.staging/ where zod is resolvable.
  const m = JSON.parse(readFileSync(join(PKG_SRC_DIR, 'manifest.json'), 'utf8'));
  writeFileSync(
    join(PKG_SRC_DIR, 'manifest.json'),
    JSON.stringify({...m, id: PKG_ID, author: 'mp-tester', license: 'MIT'}, null, 2) + '\n',
  );
  // Build marketplace index (creates zip + sha256)
  execFileSync('node', [buildIndexScript], {stdio: 'pipe'});
}

/** Full cleanup: uninstall if present, rm pkg source, rebuild index + registry. */
async function fullCleanup() {
  if (existsSync(join(TEMPLATES_DIR, PKG_ID))) {
    try {
      await uninstall(PKG_ID, {runners: stubRunners()});
    } catch { /* tolerate if already gone */ }
    // Belt-and-braces: force remove
    rmSync(join(TEMPLATES_DIR, PKG_ID), {recursive: true, force: true});
    rmSync(join(RENDER_ASSETS_DIR, PKG_ID), {recursive: true, force: true});
    rmSync(join(PREVIEWS_DIR, `${PKG_ID}.mp4`), {force: true});
    rmSync(join(PREVIEWS_DIR, `${PKG_ID}.jpg`), {force: true});
  }
  rmSync(join(marketplaceDir, 'packages', PKG_ID), {recursive: true, force: true});
  execFileSync('node', [buildIndexScript], {stdio: 'pipe'});
  execFileSync('node', [buildRegistryScript], {stdio: 'pipe'});
}

beforeEach(async () => {
  await fullCleanup();
  plantMarketplacePkg();
});

afterEach(async () => {
  await fullCleanup();
});

describe('installFromMarketplace', () => {
  it('happy path: installs zzz-mp-install, templates dir exists, registry has it', async () => {
    await installFromMarketplace(PKG_ID, {runners: stubRunners()});
    expect(existsSync(join(TEMPLATES_DIR, PKG_ID))).toBe(true);
    expect(registryContains(PKG_ID)).toBe(true);
  });

  it('unknown id: rejects with a message naming the catalog', async () => {
    const err = await installFromMarketplace('zzz-nope', {runners: stubRunners()}).then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err).toBeInstanceOf(InstallError);
    expect(err.message).toContain('catalog');
  });

  it('tampered zip: rejects stage=integrity, no templates/zzz-mp-install folder created', async () => {
    // Find the built zip path from the index
    const idx = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8'));
    const entry = idx.packages.find((p) => p.id === PKG_ID);
    expect(entry, 'entry must exist in catalog after plantMarketplacePkg').toBeTruthy();
    const zipPath = join(marketplaceDir, entry.package);
    // Tamper the zip AFTER build-index
    writeFileSync(zipPath, 'GARBAGE_BYTES');

    const err = await installFromMarketplace(PKG_ID, {runners: stubRunners()}).then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err).toBeInstanceOf(InstallError);
    expect(err.stage).toBe('integrity');
    // No folder created
    expect(existsSync(join(TEMPLATES_DIR, PKG_ID))).toBe(false);
  });

  it('CLI: node install.mjs install --from-marketplace zzz-nope → exit nonzero, stderr names catalog', () => {
    let threw = false;
    try {
      execFileSync('node', [join(__dirname, 'install.mjs'), 'install', '--from-marketplace', 'zzz-nope'], {
        stdio: 'pipe',
        cwd: __dirname,
      });
    } catch (e) {
      threw = true;
      const stderr = e.stderr?.toString() ?? '';
      expect(stderr).toContain('catalog');
    }
    expect(threw).toBe(true);
  });
});
