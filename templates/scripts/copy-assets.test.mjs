import {mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {describe, expect, it} from 'vitest';
import {mirrorStock, mirrorTemplateAssets} from '../../preview/scripts/copy-assets.mjs';

describe('copy-assets mirrors (§15.7)', () => {
  it('template-assets mirror copies AND orphan-deletes inside its namespace only', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mirror-'));
    const src = join(tmp, 'src'), dst = join(tmp, 'dst');
    mkdirSync(join(src, 'demo'), {recursive: true});
    writeFileSync(join(src, 'demo', 'a.png'), 'a');
    mkdirSync(join(dst, 'ghost'), {recursive: true});
    writeFileSync(join(dst, 'ghost', 'stale.png'), 'x');
    mirrorTemplateAssets(src, dst);
    expect(existsSync(join(dst, 'demo', 'a.png'))).toBe(true);
    expect(existsSync(join(dst, 'ghost'))).toBe(false); // orphan deleted
    rmSync(tmp, {recursive: true, force: true});
  });
  it('template-assets mirror deletes orphan FILES inside a kept folder too', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mirror2-'));
    const src = join(tmp, 'src'), dst = join(tmp, 'dst');
    mkdirSync(join(src, 'demo'), {recursive: true});
    writeFileSync(join(src, 'demo', 'a.png'), 'a');
    mkdirSync(join(dst, 'demo'), {recursive: true});
    writeFileSync(join(dst, 'demo', 'stale.png'), 'x');
    mirrorTemplateAssets(src, dst);
    expect(existsSync(join(dst, 'demo', 'a.png'))).toBe(true);
    expect(existsSync(join(dst, 'demo', 'stale.png'))).toBe(false);
    rmSync(tmp, {recursive: true, force: true});
  });
  it('R3: the stock assets mirror NEVER deletes extra destination files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stock-'));
    const src = join(tmp, 'src'), dst = join(tmp, 'dst');
    mkdirSync(src, {recursive: true});
    writeFileSync(join(src, 'real.mp4'), 'r');
    mkdirSync(dst, {recursive: true});
    writeFileSync(join(dst, 'extra.mp4'), 'keep-me');
    mirrorStock(src, dst);
    expect(existsSync(join(dst, 'real.mp4'))).toBe(true);
    expect(existsSync(join(dst, 'extra.mp4'))).toBe(true); // UNTOUCHED — §15.7
    rmSync(tmp, {recursive: true, force: true});
  });
  it('template-assets mirror with a missing source removes the whole dst namespace (zero templates with assets) without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'none-'));
    const dst = join(tmp, 'dst');
    mkdirSync(join(dst, 'old'), {recursive: true});
    writeFileSync(join(dst, 'old', 'x.png'), 'x');
    expect(() => mirrorTemplateAssets(join(tmp, 'nope'), dst)).not.toThrow();
    expect(existsSync(dst)).toBe(false);
    rmSync(tmp, {recursive: true, force: true});
  });
});
