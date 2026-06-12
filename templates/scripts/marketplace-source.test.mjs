// Run the TS seam through tsx by importing it. The templates toolchain has tsx.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const tsx = join(repoRoot, 'templates', 'node_modules', '.bin', 'tsx');
const seam = join(repoRoot, 'preview', 'lib', 'marketplace.ts');

// Harness: a tiny tsx script that imports the seam and exercises it against a tmp marketplace.
function runSeam(jsBody, marketplaceDir) {
  const harness = join(mkdtempSync(join(tmpdir(), 'seam-')), 'h.ts');
  writeFileSync(harness, `import {LocalFolderSource} from ${JSON.stringify(seam)};\n` +
    `const src = new LocalFolderSource(${JSON.stringify(marketplaceDir)});\n(async () => { ${jsBody} })().catch((e) => { console.error('ERR:' + e.message); process.exit(3); });`);
  return execFileSync(tsx, [harness], {stdio: 'pipe'}).toString();
}

function tmpMarketplace() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-'));
  const pkgDir = join(dir, 'packages', 'demo', '1.0.0');
  mkdirSync(pkgDir, {recursive: true});
  writeFileSync(join(pkgDir, 'demo-1.0.0.zip'), 'ZIPBYTES');
  const sha = createHash('sha256').update('ZIPBYTES').digest('hex');
  writeFileSync(join(dir, 'index.json'), JSON.stringify({catalogVersion: 1, packages: [
    {id: 'demo', name: 'Demo', version: '1.0.0', kind: 'scene', apiVersion: '1', author: 'acme', license: 'MIT', package: 'packages/demo/1.0.0/demo-1.0.0.zip', sha256: sha},
  ]}, null, 2));
  return {dir, sha};
}

describe('LocalFolderSource', () => {
  it('getIndex reads the committed index', () => {
    const {dir} = tmpMarketplace();
    const out = runSeam(`const i = await src.getIndex(); console.log(i.packages[0].id);`, dir);
    expect(out.trim()).toBe('demo');
    rmSync(dir, {recursive: true, force: true});
  });
  it('getIndex returns empty packages when index missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    const out = runSeam(`const i = await src.getIndex(); console.log(i.packages.length);`, dir);
    expect(out.trim()).toBe('0');
    rmSync(dir, {recursive: true, force: true});
  });
  it('fetchPackage returns the zip path when sha256 matches', () => {
    const {dir} = tmpMarketplace();
    const out = runSeam(`const i = await src.getIndex(); const r = await src.fetchPackage(i.packages[0]); console.log(r.zipPath.endsWith('demo-1.0.0.zip'));`, dir);
    expect(out.trim()).toBe('true');
    rmSync(dir, {recursive: true, force: true});
  });
  it('fetchPackage throws on sha256 mismatch (tamper)', () => {
    const {dir} = tmpMarketplace();
    writeFileSync(join(dir, 'packages', 'demo', '1.0.0', 'demo-1.0.0.zip'), 'TAMPERED');
    let threw = false;
    try { runSeam(`const i = await src.getIndex(); await src.fetchPackage(i.packages[0]);`, dir); }
    catch (e) { threw = true; expect(String(e.stderr)).toContain('sha256 mismatch'); }
    expect(threw).toBe(true);
    rmSync(dir, {recursive: true, force: true});
  });
  it('fetchPackage throws when entry.package traverses outside the store root', () => {
    const {dir} = tmpMarketplace();
    // Write an index with a traversal package path
    writeFileSync(join(dir, 'index.json'), JSON.stringify({catalogVersion: 1, packages: [
      {id: 'demo', name: 'Demo', version: '1.0.0', kind: 'scene', apiVersion: '1', author: 'acme', license: 'MIT', package: '../../escape.zip', sha256: 'aabbcc'},
    ]}, null, 2));
    let threw = false;
    try { runSeam(`const i = await src.getIndex(); await src.fetchPackage(i.packages[0]);`, dir); }
    catch (e) { threw = true; expect(String(e.stderr)).toContain('outside the store'); }
    expect(threw).toBe(true);
    rmSync(dir, {recursive: true, force: true});
  });
});
