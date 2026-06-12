import {mkdirSync, writeFileSync, rmSync, existsSync, cpSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  InstallError, listInstalled, installedState, clearLastError, scanReferences,
  _acquireLock, _releaseLock, _writeLastError, _sweepStale,
  _runValidation, STAGING_DIR, TEMPLATES_DIR, SUPPORTED_API_VERSION,
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
