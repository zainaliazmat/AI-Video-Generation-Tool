import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const repoRoot = resolve(templatesDir, '..');
const script = join(__dirname, 'build-marketplace-index.mjs');
const marketplaceDir = join(repoRoot, 'marketplace');
const FIXTURE_SRC = join(templatesDir, 'scripts', 'fixtures', 'valid-scene');
// A throwaway package id that no test/seed uses:
const PKG = 'zzz-mp-fixture';
const pkgDir = join(marketplaceDir, 'packages', PKG, '1.0.0', PKG);

afterEach(() => {
  rmSync(join(marketplaceDir, 'packages', PKG), {recursive: true, force: true});
  execFileSync('node', [script], {stdio: 'pipe'}); // rebuild index without the fixture
});

function plantFixturePackage() {
  mkdirSync(pkgDir, {recursive: true});
  // Reuse the M2 valid-scene fixture as a stand-in third-party package source.
  cpSync(FIXTURE_SRC, pkgDir, {recursive: true});
  // Rewrite its manifest to the package id + a non-core author w/ license.
  const m = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'));
  writeFileSync(join(pkgDir, 'manifest.json'),
    JSON.stringify({...m, id: PKG, author: 'mp-tester', license: 'MIT'}, null, 2) + '\n');
}

describe('build-marketplace-index', () => {
  it('emits index.json listing the planted package with a sha256 + package path', () => {
    plantFixturePackage();
    execFileSync('node', [script], {stdio: 'pipe'});
    const index = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8'));
    const entry = index.packages.find((p) => p.id === PKG);
    expect(entry).toBeTruthy();
    expect(entry.version).toBe('1.0.0');
    expect(entry.author).toBe('mp-tester');
    expect(entry.package).toBe(`packages/${PKG}/1.0.0/${PKG}-1.0.0.zip`);
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('the built zip exists at the indexed path and its bytes hash to the indexed sha256', () => {
    plantFixturePackage();
    execFileSync('node', [script], {stdio: 'pipe'});
    const index = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8'));
    const entry = index.packages.find((p) => p.id === PKG);
    const zipPath = join(marketplaceDir, entry.package);
    expect(existsSync(zipPath)).toBe(true);
    const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    expect(actual).toBe(entry.sha256);
  });
  it('DETERMINISM: double build → byte-identical zip → identical sha256', () => {
    plantFixturePackage();
    execFileSync('node', [script], {stdio: 'pipe'});
    const idx1 = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8'));
    const sha1 = idx1.packages.find((p) => p.id === PKG).sha256;
    const zip1 = readFileSync(join(marketplaceDir, idx1.packages.find((p) => p.id === PKG).package));
    execFileSync('node', [script], {stdio: 'pipe'});
    const idx2 = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8'));
    const sha2 = idx2.packages.find((p) => p.id === PKG).sha256;
    const zip2 = readFileSync(join(marketplaceDir, idx2.packages.find((p) => p.id === PKG).package));
    expect(sha2).toBe(sha1);
    expect(Buffer.compare(zip1, zip2)).toBe(0);
  });
  it('index.json itself is deterministic (no timestamp churn) — double build byte-identical', () => {
    plantFixturePackage();
    execFileSync('node', [script], {stdio: 'pipe'});
    const a = readFileSync(join(marketplaceDir, 'index.json'), 'utf8');
    execFileSync('node', [script], {stdio: 'pipe'});
    expect(readFileSync(join(marketplaceDir, 'index.json'), 'utf8')).toBe(a);
  });
  it('includes preview.poster only when poster.jpg exists beside the source', () => {
    plantFixturePackage();
    execFileSync('node', [script], {stdio: 'pipe'});
    let entry = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8')).packages.find((p) => p.id === PKG);
    expect(entry.preview?.poster).toBeUndefined();
    writeFileSync(join(marketplaceDir, 'packages', PKG, '1.0.0', 'poster.jpg'), 'jpgbytes');
    execFileSync('node', [script], {stdio: 'pipe'});
    entry = JSON.parse(readFileSync(join(marketplaceDir, 'index.json'), 'utf8')).packages.find((p) => p.id === PKG);
    expect(entry.preview.poster).toBe(`packages/${PKG}/1.0.0/poster.jpg`);
  });
});
