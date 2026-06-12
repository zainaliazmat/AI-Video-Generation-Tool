import {mkdirSync, writeFileSync, rmSync, existsSync, cpSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  InstallError, listInstalled, installedState, clearLastError, scanReferences,
  _acquireLock, _releaseLock, _writeLastError, _sweepStale,
  _runValidation, STAGING_DIR, TEMPLATES_DIR, RENDER_ASSETS_DIR, PREVIEWS_DIR,
  SCRIPTS_DIR, SUPPORTED_API_VERSION,
  install, uninstall, doctor, _defaultRunners,
} from './install.mjs';
import {zipFixture, zipRaw} from './fixtures/helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const repoRoot = resolve(templatesDir, '..');
const staging = join(templatesDir, '.staging');

beforeEach(() => rmSync(staging, {recursive: true, force: true}));

describe('single-flight lock (§15.2)', () => {
  it('second acquire while held → InstallError stage=lock statusCode=409', () => {
    _acquireLock('install');
    try {
      let err;
      try { _acquireLock('install'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(InstallError);
      expect(err.stage).toBe('lock');
      expect(err.statusCode).toBe(409);
    } finally { _releaseLock(); }
  });
  it('a stale lock (dead pid) is replaced, not honored', () => {
    mkdirSync(staging, {recursive: true});
    writeFileSync(join(staging, '.lock'), JSON.stringify({pid: 999999999, op: 'install', startedAt: 'x'}));
    _acquireLock('install');
    _releaseLock();
  });
});

describe('last-error file beside the lock (§16.15-2)', () => {
  it('write → state carries it; clear → null', () => {
    _writeLastError({op: 'install', id: 'demo', stage: 'envelope', message: 'boom'});
    expect(installedState().lastError).toMatchObject({stage: 'envelope', message: 'boom'});
    expect(typeof installedState().lastError.at).toBe('string');
    clearLastError();
    expect(installedState().lastError).toBeNull();
  });
  it('a corrupt last-error file reads as null, never throws', () => {
    mkdirSync(staging, {recursive: true});
    writeFileSync(join(staging, 'last-error.json'), '{nope');
    expect(installedState().lastError).toBeNull();
  });
});

describe('state surface (§16.15-4)', () => {
  it('lists every committed core template id', () => {
    const {installedIds, templates} = installedState();
    for (const id of ['hook', 'scene', 'stat', 'outro', 'overlay', 'enumeration', 'fade', 'slide']) {
      expect(installedIds).toContain(id);
    }
    const hook = templates.find((t) => t.id === 'hook');
    expect(hook).toMatchObject({author: 'core', kind: 'hook'});
    expect(typeof hook.uncommitted).toBe('boolean');
  });
  it('uncommitted flips to true on a dirty template dir (derived from git, §16.11)', () => {
    const marker = join(templatesDir, 'hook', 'zz-dirty-marker.txt');
    writeFileSync(marker, 'x');
    try {
      expect(installedState().templates.find((t) => t.id === 'hook').uncommitted).toBe(true);
    } finally { rmSync(marker); }
    expect(installedState().templates.find((t) => t.id === 'hook').uncommitted).toBe(false);
  });
  it('ignores folders bearing the .installing sentinel', () => {
    const fake = join(templatesDir, 'zzz-state-fixture');
    mkdirSync(fake, {recursive: true});
    writeFileSync(join(fake, 'manifest.json'), JSON.stringify({id: 'zzz-state-fixture'}));
    writeFileSync(join(fake, '.installing'), 'r');
    try {
      expect(installedState().installedIds).not.toContain('zzz-state-fixture');
    } finally { rmSync(fake, {recursive: true, force: true}); }
  });
  it('listInstalled carries id/version/kind/author/description', () => {
    const enumEntry = listInstalled().find((t) => t.id === 'enumeration');
    expect(enumEntry).toMatchObject({author: 'core', kind: 'scene'});
    expect(typeof enumEntry.version).toBe('string');
    expect(typeof enumEntry.description).toBe('string');
  });
});

describe('startup sweep (§15.2)', () => {
  it('removes templates/* folders bearing .installing and stale run dirs, keeps lock + last-error files', () => {
    const fake = join(templatesDir, 'zzz-sweep-fixture');
    mkdirSync(fake, {recursive: true});
    writeFileSync(join(fake, '.installing'), 'r');
    mkdirSync(join(staging, 'run-stale'), {recursive: true});
    _writeLastError({op: 'install', id: 'x', stage: 'preview', message: 'old'});
    _sweepStale();
    expect(existsSync(fake)).toBe(false);
    expect(existsSync(join(staging, 'run-stale'))).toBe(false);
    expect(installedState().lastError).not.toBeNull(); // sweep never clears the error surface
  });
  it('sweeps stale run-dirs even when the current process holds the lock', () => {
    _acquireLock('install');
    try {
      mkdirSync(join(staging, 'run-stale-under-own-lock'), {recursive: true});
      _sweepStale();
      expect(existsSync(join(staging, 'run-stale-under-own-lock'))).toBe(false);
    } finally {
      _releaseLock();
    }
  });
});

describe('reference scan (§15.9/§17.1)', () => {
  it('counts scenes[].template, scenes[].transition.template, layers[].template across projects/* AND root spec.json', () => {
    const proj = join(repoRoot, 'projects', 'zzz-scan-fixture');
    mkdirSync(proj, {recursive: true});
    writeFileSync(join(proj, 'spec.json'), JSON.stringify({
      scenes: [
        {id: 's1', template: 'zzz-ref-demo', transition: {template: 'zzz-ref-demo'}},
        {id: 's2', template: 'scene'},
      ],
      layers: [{id: 'l1', template: 'zzz-ref-demo'}],
    }));
    try {
      const r = scanReferences('zzz-ref-demo');
      const entry = r.files.find((f) => f.path.includes('zzz-scan-fixture'));
      expect(entry.count).toBe(3);
      expect(r.total).toBeGreaterThanOrEqual(3);
    } finally { rmSync(proj, {recursive: true, force: true}); }
  });
  it('tolerates unreadable/corrupt spec files (skips, never throws)', () => {
    const proj = join(repoRoot, 'projects', 'zzz-corrupt-fixture');
    mkdirSync(proj, {recursive: true});
    writeFileSync(join(proj, 'spec.json'), '{nope');
    try {
      expect(() => scanReferences('anything')).not.toThrow();
    } finally { rmSync(proj, {recursive: true, force: true}); }
  });
});

// ---------------------------------------------------------------------------
// Validation pipeline (_runValidation) — stages 1–5
// ---------------------------------------------------------------------------

const FIX = join(__dirname, 'fixtures', 'valid-scene');

/** Assert that a promise rejects with an InstallError at the expected stage. */
const expectStage = async (promise, stage, msgPart) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err, 'expected a rejection').toBeTruthy();
  expect(err.stage).toBe(stage);
  if (msgPart) expect(err.message).toContain(msgPart);
};

/** After each describe block that runs _runValidation, assert no stale run dirs linger. */
function assertNoRunDirs() {
  if (!existsSync(STAGING_DIR)) return;
  const runDirs = readdirSync(STAGING_DIR, {withFileTypes: true})
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => e.name);
  expect(runDirs, 'stale run dirs in .staging — self-clean contract broken').toEqual([]);
}

// ---------------------------------------------------------------------------
// Stage 1: unpack
// ---------------------------------------------------------------------------
describe('stage 1 unpack', () => {
  afterEach(assertNoRunDirs);

  it('zip-slip entry with .. path → InstallError stage=unpack containing ..', async () => {
    // Use zipRaw: AdmZip normalizes '../evil.txt' to 'evil.txt' at write time;
    // Python's zipfile preserves the raw entry name so the validator sees '..'
    const zip = zipRaw([['fixture-card/manifest.json', '{}'], ['../evil.txt', 'bad']]);
    await expectStage(_runValidation(zip), 'unpack', '..');
  });

  it('zip entry with absolute /etc/evil path → InstallError stage=unpack', async () => {
    // Use zipRaw so the leading '/' is preserved in the stored entry name
    const zip = zipRaw([['fixture-card/manifest.json', '{}'], ['/etc/evil', 'bad']]);
    await expectStage(_runValidation(zip), 'unpack');
  });

  it('two top-level folders → InstallError stage=unpack containing top-level', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('alpha/manifest.json', Buffer.from('{}'));
    zip.addFile('beta/manifest.json', Buffer.from('{}'));
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const out = join(mkdtempSync(join(tmpdir(), 'fixzip-')), 'two.zip');
    zip.writeZip(out);
    await expectStage(_runValidation(out), 'unpack', 'top-level');
  });

  it('2001 entries → InstallError stage=unpack containing entries', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    // Need 2001 entries all under one top-level folder
    for (let i = 0; i < 2001; i++) {
      zip.addFile(`fixture-card/pad-${i}.txt`, Buffer.from('x'));
    }
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const out = join(mkdtempSync(join(tmpdir(), 'fixzip-')), 'big.zip');
    zip.writeZip(out);
    await expectStage(_runValidation(out), 'unpack', 'entries');
  });

  it('one 201MB zeros entry → InstallError stage=unpack containing decompressed', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    // 201 MB of zeros
    zip.addFile('fixture-card/bomb.bin', Buffer.alloc(201 * 1024 * 1024));
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const out = join(mkdtempSync(join(tmpdir(), 'fixzip-')), 'bomb.zip');
    zip.writeZip(out);
    await expectStage(_runValidation(out), 'unpack', 'decompressed');
  });

  it('plain text file (not a zip) → InstallError stage=unpack', async () => {
    const {mkdtempSync, writeFileSync: wf} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const out = join(mkdtempSync(join(tmpdir(), 'fixzip-')), 'fake.zip');
    wf(out, 'this is not a zip');
    await expectStage(_runValidation(out), 'unpack');
  });

  it('directory source validates in place — returns manifest id fixture-card', async () => {
    const result = await _runValidation(FIX);
    expect(result.manifest.id).toBe('fixture-card');
    // cleanup the run dir
    rmSync(result.runDir, {recursive: true, force: true});
  });
});

// ---------------------------------------------------------------------------
// Directory-source safety (path-traversal guard)
// ---------------------------------------------------------------------------
describe('directory-source safety', () => {
  afterEach(assertNoRunDirs);

  it('dir-source manifest.id "../../zzz-pwned-victim" → InstallError stage=unpack (no file created)', async () => {
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const evilDir = mkdtempSync(join(tmpdir(), 'evil-dir-'));
    // Build a valid-looking manifest except for the malicious id
    writeFileSync(join(evilDir, 'manifest.json'), JSON.stringify({
      id: '../../zzz-pwned-victim',
      name: 'Evil',
      version: '1.0.0',
      author: 'evil-author',
      apiVersion: '1',
      kind: 'scene',
      description: 'Path traversal attempt.',
      tags: ['test'],
      license: 'MIT',
      inputSchema: {type: 'object', additionalProperties: false},
      sampleProps: {},
      durationFrames: {min: 30, max: 120},
    }));
    try {
      await expectStage(_runValidation(evilDir), 'unpack', 'zzz-pwned-victim');
    } finally {
      rmSync(evilDir, {recursive: true, force: true});
    }
    // Assert no escaped file/dir was created
    expect(existsSync(join(templatesDir, '..', 'zzz-pwned-victim')), 'victim dir created at repo root').toBe(false);
    expect(existsSync(join(templatesDir, 'zzz-pwned-victim')), 'victim dir created inside templates/').toBe(false);
  });

  it('dir-source with valid id but folder name != id (ergonomic case) — still validates successfully', async () => {
    // Folder name is a tmp dir name (random), manifest.id = 'fixture-card' — must work
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'any-folder-name-'));
    cpSync(FIX, tmp, {recursive: true}); // copies fixture-card contents; manifest.id = 'fixture-card'
    try {
      const result = await _runValidation(tmp);
      expect(result.manifest.id).toBe('fixture-card');
      rmSync(result.runDir, {recursive: true, force: true});
    } finally {
      rmSync(tmp, {recursive: true, force: true});
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 2: envelope
// ---------------------------------------------------------------------------
describe('stage 2 envelope', () => {
  afterEach(assertNoRunDirs);

  it('missing required field kind → InstallError stage=envelope containing kind', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => { delete m.kind; return m; }});
    await expectStage(_runValidation(zip), 'envelope', 'kind');
  });

  it('unknown field surprise:true → InstallError stage=envelope containing surprise', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => { m.surprise = true; return m; }});
    await expectStage(_runValidation(zip), 'envelope', 'surprise');
  });
});

// ---------------------------------------------------------------------------
// Contract (§15.13 / §4.4)
// ---------------------------------------------------------------------------
describe('contract checks (§15.13)', () => {
  afterEach(assertNoRunDirs);

  it('missing license for non-core → InstallError stage=contract containing license', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => { delete m.license; return m; }});
    await expectStage(_runValidation(zip), 'contract', 'license');
  });

  it('assets ship without CREDITS.json → InstallError stage=contract containing CREDITS', async () => {
    // Copy fixture to tmp, remove CREDITS.json, then zip
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'fix-nocredits-'));
    cpSync(FIX, tmp, {recursive: true});
    rmSync(join(tmp, 'assets', 'CREDITS.json'), {force: true});
    const zip = zipFixture(tmp);
    rmSync(tmp, {recursive: true, force: true});
    await expectStage(_runValidation(zip), 'contract', 'CREDITS');
  });

  it('undeclared asset file in assets/ → InstallError stage=contract containing the filename', async () => {
    const zip = zipFixture(FIX, {extraEntries: [['fixture-card/assets/sneaky.bin', 'bad']]});
    await expectStage(_runValidation(zip), 'contract', 'sneaky.bin');
  });

  it('declared ghost asset not present in package → InstallError stage=contract containing ghost.png', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => {
      m.assets = [...(m.assets ?? []), 'assets/ghost.png'];
      return m;
    }});
    await expectStage(_runValidation(zip), 'contract', 'ghost.png');
  });
});

// ---------------------------------------------------------------------------
// Stage 3: id
// ---------------------------------------------------------------------------
describe('stage 3 id', () => {
  afterEach(assertNoRunDirs);

  it('top folder name differs from manifest id → InstallError stage=id containing folder', async () => {
    const zip = zipFixture(FIX, {topName: 'other-name'}); // manifest id still fixture-card
    await expectStage(_runValidation(zip), 'id', 'folder');
  });

  it('id with invalid chars (Bad_ID) → InstallError stage=id', async () => {
    const zip = zipFixture(FIX, {topName: 'Bad_ID', mutateManifest: (m) => { m.id = 'Bad_ID'; return m; }});
    await expectStage(_runValidation(zip), 'id');
  });

  it('reserved id "scripts" → InstallError stage=id containing reserved', async () => {
    const zip = zipFixture(FIX, {topName: 'scripts', mutateManifest: (m) => { m.id = 'scripts'; return m; }});
    await expectStage(_runValidation(zip), 'id', 'reserved');
  });

  it('collision with existing "hook" (no update) → InstallError stage=id', async () => {
    const zip = zipFixture(FIX, {topName: 'hook', mutateManifest: (m) => { m.id = 'hook'; return m; }});
    await expectStage(_runValidation(zip), 'id');
  });

  it('update on core template → InstallError stage=id containing core', async () => {
    const zip = zipFixture(FIX, {
      topName: 'hook',
      mutateManifest: (m) => { m.id = 'hook'; m.version = '99.0.0'; return m; },
    });
    await expectStage(_runValidation(zip, {update: true}), 'id', 'core');
  });

  it('manifest-less disk dir collision: rejects without update and with update', async () => {
    const ghostDir = join(TEMPLATES_DIR, 'zzz-ghost-dir');
    mkdirSync(ghostDir, {recursive: true});
    try {
      const zip1 = zipFixture(FIX, {topName: 'zzz-ghost-dir', mutateManifest: (m) => { m.id = 'zzz-ghost-dir'; return m; }});
      const zip2 = zipFixture(FIX, {topName: 'zzz-ghost-dir', mutateManifest: (m) => { m.id = 'zzz-ghost-dir'; return m; }});
      await expectStage(_runValidation(zip1), 'id');
      await expectStage(_runValidation(zip2, {update: true}), 'id');
    } finally {
      rmSync(ghostDir, {recursive: true, force: true});
    }
  });

  it('consumes "enumeration" conflicts → InstallError stage=id containing consumes', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => { m.consumes = 'enumeration'; return m; }});
    await expectStage(_runValidation(zip), 'id', 'consumes');
  });

  it('consumes conflict with overrideCapability:true → passes (cleanup runDir)', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => { m.consumes = 'enumeration'; return m; }});
    const result = await _runValidation(zip, {overrideCapability: true});
    rmSync(result.runDir, {recursive: true, force: true});
  });

  describe('update ladder (§15.3)', () => {
    const installedDir = join(TEMPLATES_DIR, 'fixture-card');
    beforeEach(() => { cpSync(FIX, installedDir, {recursive: true}); });
    afterEach(() => { rmSync(installedDir, {recursive: true, force: true}); });

    it('version 1.1.0 with update:true → passes, returns existing 1.0.0', async () => {
      const zip = zipFixture(FIX, {mutateManifest: (m) => { m.version = '1.1.0'; return m; }});
      const result = await _runValidation(zip, {update: true});
      expect(result.existing).toBeTruthy();
      expect(result.existing.version).toBe('1.0.0');
      rmSync(result.runDir, {recursive: true, force: true});
    });

    it('version 0.9.0 with update → InstallError stage=id containing downgrade', async () => {
      const zip = zipFixture(FIX, {mutateManifest: (m) => { m.version = '0.9.0'; return m; }});
      await expectStage(_runValidation(zip, {update: true, confirmReplace: true}), 'id', 'downgrade');
    });

    it('same version update only → InstallError stage=id containing confirm', async () => {
      const zip = zipFixture(FIX); // version 1.0.0 == installed
      await expectStage(_runValidation(zip, {update: true}), 'id', 'confirm');
    });

    it('same version update+confirmReplace → passes', async () => {
      const zip = zipFixture(FIX); // version 1.0.0
      const result = await _runValidation(zip, {update: true, confirmReplace: true});
      expect(result.manifest.version).toBe('1.0.0');
      rmSync(result.runDir, {recursive: true, force: true});
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 4: compat
// ---------------------------------------------------------------------------
describe('stage 4 compat', () => {
  afterEach(assertNoRunDirs);

  it('apiVersion "2" → InstallError stage=compat containing apiVersion', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => { m.apiVersion = '2'; return m; }});
    await expectStage(_runValidation(zip), 'compat', 'apiVersion');
  });
});

// ---------------------------------------------------------------------------
// Stage 5: schema
// ---------------------------------------------------------------------------
describe('stage 5 schema', () => {
  afterEach(assertNoRunDirs);

  it('stale inputSchema (bogus property injected) → InstallError stage=schema containing stale', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => {
      m.inputSchema = {...m.inputSchema, bogus: 'injected'};
      return m;
    }});
    await expectStage(_runValidation(zip), 'schema', 'stale');
  });

  it('sampleProps do not satisfy inputSchema → InstallError stage=schema containing sampleProps', async () => {
    const zip = zipFixture(FIX, {mutateManifest: (m) => {
      m.sampleProps = {wrong: true};
      return m;
    }});
    await expectStage(_runValidation(zip), 'schema', 'sampleProps');
  });

  it('transition kind (no schema.ts) — regen skipped, sampleProps validated, passes', async () => {
    // Build a tmp fixture dir for a transition (no schema.ts)
    const {mkdtempSync} = await import('node:fs');
    const {tmpdir} = await import('node:os');
    const tmpFix = mkdtempSync(join(tmpdir(), 'fix-transition-'));
    const presentationTsx = `import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentation, TransitionPresentationComponentProps} from '@remotion/transitions';

type P = Record<string, unknown>;
const Presentation: React.FC<TransitionPresentationComponentProps<P>> = ({children, presentationProgress, presentationDirection}) => {
  const reveal = presentationDirection === 'entering' ? presentationProgress : 1;
  return (
    <AbsoluteFill style={{clipPath: presentationDirection === 'entering' ? \`inset(0 \${(1 - reveal) * 100}% 0 0)\` : undefined}}>
      {children}
    </AbsoluteFill>
  );
};
const factory = (_props?: P): TransitionPresentation<P> => ({component: Presentation, props: {}});
export default factory;
`;
    writeFileSync(join(tmpFix, 'presentation.tsx'), presentationTsx);
    writeFileSync(join(tmpFix, 'manifest.json'), JSON.stringify({
      id: 'fixture-wipe',
      name: 'Fixture Wipe',
      version: '1.0.0',
      author: 'fixture-author',
      apiVersion: '1',
      kind: 'transition',
      description: 'Transition fixture.',
      tags: ['fixture'],
      license: 'MIT',
      inputSchema: {'type': 'object', 'additionalProperties': false},
      sampleProps: {},
      durationFrames: {min: 10, max: 40},
    }, null, 2) + '\n');
    try {
      const result = await _runValidation(tmpFix);
      expect(result.manifest.kind).toBe('transition');
      rmSync(result.runDir, {recursive: true, force: true});
    } finally {
      rmSync(tmpFix, {recursive: true, force: true});
    }
  });
});

// ---------------------------------------------------------------------------
// Task 10: install / uninstall / doctor orchestration (§15.2 / §15.9)
// ---------------------------------------------------------------------------

const FIX_SRC = join(__dirname, 'fixtures', 'valid-scene');

/**
 * Build a stubbed runners set.
 * - tsc, genPreviews, copyAssets are no-ops (captured in calls[]).
 * - buildRegistry is REAL (runs the actual build-registry.mjs) so that
 *   registry.generated.ts reflects the current templates/ state and
 *   "is fixture-card in registry?" assertions work.
 */
function stubRunners(overrides = {}) {
  const calls = [];
  return {
    calls,
    runners: {
      tsc: () => { calls.push('tsc'); },
      buildRegistry: () => {
        calls.push('buildRegistry');
        execFileSync('node', [join(__dirname, 'build-registry.mjs')], {stdio: 'pipe'});
      },
      genManifests: _defaultRunners.genManifests,
      genPreviews: (id) => { calls.push(`genPreviews:${id}`); },
      copyAssets: () => { calls.push('copyAssets'); },
      ...overrides,
    },
  };
}

/** Read registry.generated.ts and return true if `id` appears in it. */
function registryContains(id) {
  const reg = join(__dirname, '..', 'registry.generated.ts');
  if (!existsSync(reg)) return false;
  return readFileSync(reg, 'utf8').includes(JSON.stringify(id));
}

/** Clean up all fixture-card / fixture-wipe residue after each orchestration test. */
async function cleanOrchestrationFixtures() {
  const ids = ['fixture-card', 'fixture-wipe'];
  for (const id of ids) {
    rmSync(join(TEMPLATES_DIR, id), {recursive: true, force: true});
    rmSync(join(RENDER_ASSETS_DIR, id), {recursive: true, force: true});
    rmSync(join(PREVIEWS_DIR, `${id}.mp4`), {force: true});
    rmSync(join(PREVIEWS_DIR, `${id}.jpg`), {force: true});
  }
  // Drop any test-added lock entries from previews.lock.json
  const lockPath = join(PREVIEWS_DIR, 'previews.lock.json');
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      for (const id of ids) delete lock[id];
      writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    } catch { /* tolerate */ }
  }
  // Restore registry to 8 core templates
  execFileSync('node', [join(__dirname, 'build-registry.mjs')], {stdio: 'pipe'});
}

// ---------------------------------------------------------------------------
// onStage progress hook (§16.3/§16.15-1 — M4 SSE surface)
// ---------------------------------------------------------------------------

describe('onStage progress hook (§16.3/§16.15-1)', () => {
  afterEach(cleanOrchestrationFixtures);

  it('install fires onStage in the correct order: validating → typecheck → assets → register → rendering-preview → done', async () => {
    const stages = [];
    const {runners} = stubRunners();
    await install(FIX_SRC, {runners, onStage: (s) => stages.push(s)});
    expect(stages).toEqual(['validating', 'typecheck', 'assets', 'register', 'rendering-preview', 'done']);
  });

  it('omitting onStage does not throw (happy-path contract)', async () => {
    const {runners} = stubRunners();
    // No onStage in opts — existing tests already prove this; explicit here for clarity.
    const result = await install(FIX_SRC, {runners});
    expect(result.id).toBe('fixture-card');
  });

  it('uninstall fires onStage: removing → done', async () => {
    // Install first so uninstall has something to remove
    const {runners: r1} = stubRunners();
    await install(FIX_SRC, {runners: r1});

    const stages = [];
    const {runners: r2} = stubRunners();
    await uninstall('fixture-card', {runners: r2, onStage: (s) => stages.push(s)});
    expect(stages).toEqual(['removing', 'done']);
  });
});

describe('install orchestration (§15.2)', () => {
  afterEach(cleanOrchestrationFixtures);

  it('T1 happy path: call order, assets shipped, sentinel gone, registry updated, result shape', async () => {
    const {calls, runners} = stubRunners();
    const result = await install(FIX_SRC, {runners});

    // Call order
    expect(calls).toEqual(['tsc', 'buildRegistry', 'genPreviews:fixture-card', 'copyAssets']);

    // Result shape
    expect(result).toMatchObject({id: 'fixture-card', version: '1.0.0', kind: 'scene', updated: null});
    expect(result.preview).toBe('previews/fixture-card.mp4');

    // Sentinel is gone
    expect(existsSync(join(TEMPLATES_DIR, 'fixture-card', '.installing'))).toBe(false);

    // Declared assets shipped to RENDER_ASSETS_DIR
    expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card', 'dot.png'))).toBe(true);
    expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card', 'CREDITS.json'))).toBe(true);

    // Registry contains fixture-card
    expect(registryContains('fixture-card')).toBe(true);

    // lastError cleared
    expect(installedState().lastError).toBeNull();
  });

  it('T1b copyAssets throws post-install → install() RESOLVES, result.id===fixture-card, lastError===null, registry contains fixture-card', async () => {
    // Pre-fix: this test would REJECT because copyAssets threw after clearLastError was
    // called AFTER copyAssets. Post-fix: clearLastError runs first, copyAssets is
    // best-effort, so the promise resolves normally.
    const {runners} = stubRunners({
      copyAssets: () => { throw new Error('mirror blew up'); },
    });
    const result = await install(FIX_SRC, {runners});
    expect(result.id).toBe('fixture-card');
    expect(installedState().lastError).toBeNull();
    expect(registryContains('fixture-card')).toBe(true);
  });

  it('T2 tsc failure: rejects stage=typecheck, folder gone, registry NOT called', async () => {
    const {calls, runners} = stubRunners({
      tsc: () => { throw Object.assign(new Error('TS2322 type error boom'), {stdout: Buffer.from(''), stderr: Buffer.from('TS2322 type error boom')}); },
    });
    await expectStage(install(FIX_SRC, {runners}), 'typecheck', 'TS');
    expect(existsSync(join(TEMPLATES_DIR, 'fixture-card'))).toBe(false);
    expect(calls.filter(c => c === 'buildRegistry')).toHaveLength(0);
    expect(registryContains('fixture-card')).toBe(false);
    expect(installedState().lastError?.stage).toBe('typecheck');
  });

  it('T3 preview failure: rejects stage=preview, folder+assets gone, buildRegistry called twice (register + rollback)', async () => {
    const {calls, runners} = stubRunners({
      genPreviews: () => { throw new Error('render crashed'); },
    });
    await expectStage(install(FIX_SRC, {runners}), 'preview');
    expect(existsSync(join(TEMPLATES_DIR, 'fixture-card'))).toBe(false);
    expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card'))).toBe(false);
    expect(calls.filter(c => c === 'buildRegistry')).toHaveLength(2);
    expect(registryContains('fixture-card')).toBe(false);
  });

  it('T4 --update semver-up: result.updated.from is old version, manifest on disk is new version', async () => {
    const {runners: r1} = stubRunners();
    await install(FIX_SRC, {runners: r1});

    // Build a 1.1.0 version of the fixture
    const zip110 = zipFixture(FIX_SRC, {mutateManifest: (m) => { m.version = '1.1.0'; return m; }});
    const {runners: r2} = stubRunners();
    const result = await install(zip110, {update: true, runners: r2});

    expect(result.updated).toMatchObject({from: '1.0.0'});
    const onDisk = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'fixture-card', 'manifest.json'), 'utf8'));
    expect(onDisk.version).toBe('1.1.0');
  });

  it('T5 --update tsc failure restores old version', async () => {
    const {runners: r1} = stubRunners();
    await install(FIX_SRC, {runners: r1});

    const zip120 = zipFixture(FIX_SRC, {mutateManifest: (m) => { m.version = '1.2.0'; return m; }});
    const {runners: r2} = stubRunners({
      tsc: () => { throw Object.assign(new Error('TS2344'), {stdout: Buffer.from(''), stderr: Buffer.from('TS2344')}); },
    });
    await expectStage(install(zip120, {update: true, runners: r2}), 'typecheck');

    // Old version still on disk
    const onDisk = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'fixture-card', 'manifest.json'), 'utf8'));
    expect(onDisk.version).toBe('1.0.0');
  });

  it('T6 same-version replace via confirmReplace:true → result.updated.from is old version', async () => {
    const {runners: r1} = stubRunners();
    await install(FIX_SRC, {runners: r1});

    const {runners: r2} = stubRunners();
    const result = await install(FIX_SRC, {update: true, confirmReplace: true, runners: r2});
    expect(result.updated).toMatchObject({from: '1.0.0'});
  });

  it('T7 sha256 mismatch → rejects stage=integrity before unpack (no folder created)', async () => {
    const zip = zipFixture(FIX_SRC);
    const {runners} = stubRunners();
    await expectStage(
      install(zip, {sha256: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', runners}),
      'integrity',
    );
    expect(existsSync(join(TEMPLATES_DIR, 'fixture-card'))).toBe(false);
  });

  it('T7b sha256 correct hash → passes', async () => {
    const zip = zipFixture(FIX_SRC);
    const {createHash} = await import('node:crypto');
    const actual = createHash('sha256').update(readFileSync(zip)).digest('hex');
    const {runners} = stubRunners();
    const result = await install(zip, {sha256: actual, runners});
    expect(result.id).toBe('fixture-card');
  });

  it('T7c sha256 on directory source → rejects with clear message', async () => {
    const {runners} = stubRunners();
    await expectStage(
      install(FIX_SRC, {sha256: 'abc123', runners}),
      'integrity',
    );
  });

  it('T8 concurrent 409: second install while first holds lock → stage=lock', async () => {
    let resolveGate;
    const gate = new Promise((res) => { resolveGate = res; });
    const {runners: r1} = stubRunners({
      tsc: () => gate,
    });
    const p1 = install(FIX_SRC, {runners: r1});

    // Give p1 time to acquire lock and enter tsc runner
    await new Promise((res) => setTimeout(res, 200));

    const {runners: r2} = stubRunners();
    await expectStage(install(FIX_SRC, {runners: r2}), 'lock');

    resolveGate();
    await p1;
  });
});

describe('uninstall orchestration (§15.9)', () => {
  afterEach(cleanOrchestrationFixtures);

  it('T9a refuse core template → stage=uninstall containing "core"', async () => {
    const {runners} = stubRunners();
    await expectStage(uninstall('hook', {runners}), 'uninstall', 'core');
  });

  it('T9b unknown id → stage=uninstall', async () => {
    const {runners} = stubRunners();
    await expectStage(uninstall('nonexistent-template-xyz', {runners}), 'uninstall');
  });

  it('T9c full removal: folder+assets+previews+lockentry gone, referencedBy.total===1', async () => {
    // Install first
    const {runners: r1} = stubRunners();
    await install(FIX_SRC, {runners: r1});

    // Plant preview stubs
    writeFileSync(join(PREVIEWS_DIR, 'fixture-card.mp4'), 'fake-mp4');
    writeFileSync(join(PREVIEWS_DIR, 'fixture-card.jpg'), 'fake-jpg');

    // Plant a lock entry
    const lockPath = join(PREVIEWS_DIR, 'previews.lock.json');
    let lock = {};
    try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* */ }
    lock['fixture-card'] = 'abc123';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

    // Plant a referencing project
    const projDir = join(resolve(TEMPLATES_DIR, '..'), 'projects', 'zzz-uninstall-fixture');
    mkdirSync(projDir, {recursive: true});
    writeFileSync(join(projDir, 'spec.json'), JSON.stringify({
      scenes: [{id: 's1', template: 'fixture-card'}],
    }));

    try {
      const {runners: r2} = stubRunners();
      const result = await uninstall('fixture-card', {runners: r2});

      expect(result.referencedBy.total).toBe(1);
      expect(existsSync(join(TEMPLATES_DIR, 'fixture-card'))).toBe(false);
      expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card'))).toBe(false);
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-card.mp4'))).toBe(false);
      expect(existsSync(join(PREVIEWS_DIR, 'fixture-card.jpg'))).toBe(false);

      // Lock entry gone
      const lockAfter = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(lockAfter['fixture-card']).toBeUndefined();

      expect(registryContains('fixture-card')).toBe(false);
    } finally {
      rmSync(projDir, {recursive: true, force: true});
      // Clean up preview stubs already removed by uninstall; force=true handles it
      rmSync(join(PREVIEWS_DIR, 'fixture-card.mp4'), {force: true});
      rmSync(join(PREVIEWS_DIR, 'fixture-card.jpg'), {force: true});
      // Restore lock
      try {
        const lockFinal = JSON.parse(readFileSync(lockPath, 'utf8'));
        delete lockFinal['fixture-card'];
        writeFileSync(lockPath, JSON.stringify(lockFinal, null, 2) + '\n');
      } catch { /* */ }
    }
  });
});

describe('doctor orchestration (§15.2)', () => {
  afterEach(cleanOrchestrationFixtures);

  it('T10a clean fixture → {ok:true} and zero residue (no templates/fixture-card, registry=8)', async () => {
    const {runners} = stubRunners();
    const result = await doctor(FIX_SRC, {runners});
    expect(result).toMatchObject({ok: true, id: 'fixture-card', version: '1.0.0', kind: 'scene'});

    // Doctor ALWAYS rolls back — no residue
    expect(existsSync(join(TEMPLATES_DIR, 'fixture-card'))).toBe(false);
    expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card'))).toBe(false);
    expect(registryContains('fixture-card')).toBe(false);
  });

  it('T10b failing candidate (tsc throws) → rejects stage=typecheck, zero residue', async () => {
    const {runners} = stubRunners({
      tsc: () => { throw Object.assign(new Error('TS2322 doctor fail'), {stdout: Buffer.from(''), stderr: Buffer.from('TS2322 doctor fail')}); },
    });
    await expectStage(doctor(FIX_SRC, {runners}), 'typecheck');
    expect(existsSync(join(TEMPLATES_DIR, 'fixture-card'))).toBe(false);
    expect(existsSync(join(RENDER_ASSETS_DIR, 'fixture-card'))).toBe(false);
    expect(registryContains('fixture-card')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI shell tests (§12 / Task 12)
// ---------------------------------------------------------------------------

describe('CLI', () => {
  // Helper: run the CLI as a subprocess and return stdout as a string.
  // On nonzero exit, execFileSync throws with .status and .stderr on the error.
  const cli = (args, opts = {}) =>
    execFileSync('node', [join(__dirname, 'install.mjs'), ...args], {
      stdio: 'pipe',
      ...opts,
    }).toString();

  it('list prints core ids', () => {
    expect(cli(['list'])).toContain('enumeration');
  });

  it('state prints JSON with installedIds', () => {
    expect(JSON.parse(cli(['state'])).installedIds).toContain('hook');
  });

  it('clear-last-error exits 0', () => {
    // Must not throw (exit 0)
    cli(['clear-last-error']);
  });

  it('no command prints usage and exits 1', () => {
    let err;
    try { cli([]); } catch (e) { err = e; }
    expect(err.status).toBe(1);
    // Usage mentions all commands
    expect(String(err.stderr)).toContain('install');
    expect(String(err.stderr)).toContain('uninstall');
    expect(String(err.stderr)).toContain('doctor');
  });

  it('unknown command prints usage and exits 1', () => {
    let err;
    try { cli(['bogus-command']); } catch (e) { err = e; }
    expect(err.status).toBe(1);
  });

  it('install of an envelope-bad zip exits nonzero and names the stage', () => {
    // Build a bad zip (missing 'kind' field — fails at stage 2 envelope, BEFORE tsc/render)
    const zip = zipFixture(FIX, {mutateManifest: (m) => { delete m.kind; return m; }});
    let err;
    try { cli(['install', zip]); } catch (e) { err = e; }
    expect(err.status).not.toBe(0);
    expect(String(err.stderr)).toContain('envelope');
  });

  it('uninstall of core template prints protection message and exits nonzero', () => {
    let err;
    try { cli(['uninstall', 'hook']); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).not.toBe(0);
    expect(String(err.stderr)).toContain('core');
  });

  it('uninstall of unknown id exits nonzero', () => {
    let err;
    try { cli(['uninstall', 'zzz-nope']); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).not.toBe(0);
  });

  it('install without src argument exits nonzero', () => {
    let err;
    try { cli(['install']); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).not.toBe(0);
  });

  it('uninstall without id argument exits nonzero', () => {
    let err;
    try { cli(['uninstall']); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).not.toBe(0);
  });

  it('doctor without src argument exits nonzero', () => {
    let err;
    try { cli(['doctor']); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.status).not.toBe(0);
  });
});
