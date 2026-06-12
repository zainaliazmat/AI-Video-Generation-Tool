import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, rmSync, readFileSync, cpSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {Buffer} from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const repoRoot = resolve(templatesDir, '..');
const script = join(repoRoot, 'remotion', 'scripts', 'gen-previews.mjs');
const FAKE = join(templatesDir, 'zzz-preview-fixture');
const dryRun = (...args) =>
  execFileSync('node', [script, '--dry-run', ...args], {stdio: 'pipe'}).toString();

afterEach(() => rmSync(FAKE, {recursive: true, force: true}));

function makeFake() {
  mkdirSync(join(FAKE, 'assets'), {recursive: true});
  const scene = JSON.parse(readFileSync(join(templatesDir, 'scene', 'manifest.json'), 'utf8'));
  writeFileSync(join(FAKE, 'manifest.json'), JSON.stringify({...scene, id: 'zzz-preview-fixture'}, null, 2));
  cpSync(join(templatesDir, 'scene', 'Component.tsx'), join(FAKE, 'Component.tsx'));
  writeFileSync(join(FAKE, 'helper.ts'), 'export const X = 1;\n');
  writeFileSync(join(FAKE, 'assets', 'a.txt'), 'v1');
}

// --dry-run prints one line per template in scope: "<id> <inputHash> <STALE|fresh>"
function hashOf(out, id) {
  const line = out.split('\n').find((l) => l.trim().startsWith(`${id} `));
  return line?.trim().split(/\s+/)[1];
}

describe('gen-previews shared-helper salt', () => {
  it('editing a root-level shared helper flips EVERY template hash', () => {
    const sharedHelper = join(templatesDir, 'countUp.ts');
    const originalBytes = readFileSync(sharedHelper);
    try {
      const out1 = dryRun();
      const hookHash1 = hashOf(out1, 'hook');
      const fadeHash1 = hashOf(out1, 'fade');
      expect(hookHash1).toBeTruthy();
      expect(fadeHash1).toBeTruthy();

      // Mutate the shared helper
      writeFileSync(sharedHelper, Buffer.concat([originalBytes, Buffer.from('\n// salt-test\n')]));

      const out2 = dryRun();
      const hookHash2 = hashOf(out2, 'hook');
      const fadeHash2 = hashOf(out2, 'fade');
      expect(hookHash2).toBeTruthy();
      expect(fadeHash2).toBeTruthy();

      expect(hookHash2).not.toBe(hookHash1);
      expect(fadeHash2).not.toBe(fadeHash1);
    } finally {
      writeFileSync(sharedHelper, originalBytes);
      // Verify tree is clean — restore must be byte-identical
      const status = execFileSync('git', ['status', '--porcelain', 'templates/countUp.ts'], {
        cwd: repoRoot,
        stdio: 'pipe',
      }).toString().trim();
      expect(status).toBe('');
    }
  });
});

describe('gen-previews --dry-run / --only / whole-folder hash', () => {
  it('lists an unknown-to-the-lock template as STALE', () => {
    makeFake();
    const out = dryRun();
    expect(out).toContain('zzz-preview-fixture');
    expect(out.split('\n').find((l) => l.includes('zzz-preview-fixture'))).toContain('STALE');
  });
  it('--only restricts scope to the target', () => {
    makeFake();
    const out = dryRun('--only', 'zzz-preview-fixture');
    expect(out).toContain('zzz-preview-fixture');
    expect(out).not.toMatch(/^hook /m);
  });
  it('--only with an unknown id fails loudly', () => {
    expect(() => dryRun('--only', 'zzz-no-such-template')).toThrow();
  });
  it('helpers-only change flips the input hash (whole-folder regime, §15.2)', () => {
    makeFake();
    const h1 = hashOf(dryRun(), 'zzz-preview-fixture');
    expect(h1).toBeTruthy();
    writeFileSync(join(FAKE, 'helper.ts'), 'export const X = 2;\n');
    const h2 = hashOf(dryRun(), 'zzz-preview-fixture');
    expect(h2).toBeTruthy();
    expect(h2).not.toBe(h1);
  });
  it('assets change flips the input hash too', () => {
    makeFake();
    const h1 = hashOf(dryRun(), 'zzz-preview-fixture');
    writeFileSync(join(FAKE, 'assets', 'a.txt'), 'v2');
    expect(hashOf(dryRun(), 'zzz-preview-fixture')).not.toBe(h1);
  });
});
