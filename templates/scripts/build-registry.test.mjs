import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, rmSync, readFileSync, cpSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const registryPath = join(templatesDir, 'registry.generated.ts');
const run = () => execFileSync('node', [join(__dirname, 'build-registry.mjs')], {stdio: 'pipe'});
const FAKE = join(templatesDir, 'zzz-sentinel-fixture');
const DOT = join(templatesDir, '.zzz-dot-fixture');

afterEach(() => {
  rmSync(FAKE, {recursive: true, force: true});
  rmSync(DOT, {recursive: true, force: true});
  run();
});

function makeFake(dir, id, {sentinel} = {}) {
  mkdirSync(dir, {recursive: true});
  const scene = JSON.parse(readFileSync(join(templatesDir, 'scene', 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({...scene, id}, null, 2));
  cpSync(join(templatesDir, 'scene', 'Component.tsx'), join(dir, 'Component.tsx'));
  if (sentinel) writeFileSync(join(dir, '.installing'), 'run-test');
}

describe('discover() skips', () => {
  it('registers a normal new folder (control)', () => {
    makeFake(FAKE, 'zzz-sentinel-fixture');
    run();
    expect(readFileSync(registryPath, 'utf8')).toContain('zzz-sentinel-fixture');
  });
  it('skips a folder containing the .installing sentinel — byte-identical registry (§15.2)', () => {
    run();
    const before = readFileSync(registryPath, 'utf8');
    makeFake(FAKE, 'zzz-sentinel-fixture', {sentinel: true});
    run();
    expect(readFileSync(registryPath, 'utf8')).toBe(before);
  });
  it('skips leading-dot folders even when they carry a manifest (§17.4)', () => {
    run();
    const before = readFileSync(registryPath, 'utf8');
    makeFake(DOT, 'zzz-dot-fixture');
    run();
    expect(readFileSync(registryPath, 'utf8')).toBe(before);
  });
  it('is byte-stable across a double run (regression)', () => {
    run();
    const a = readFileSync(registryPath, 'utf8');
    run();
    expect(readFileSync(registryPath, 'utf8')).toBe(a);
  });
});
