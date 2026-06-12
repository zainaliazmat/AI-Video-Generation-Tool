import {mkdirSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  InstallError, listInstalled, installedState, clearLastError, scanReferences,
  _acquireLock, _releaseLock, _writeLastError, _sweepStale,
} from './install.mjs';

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
