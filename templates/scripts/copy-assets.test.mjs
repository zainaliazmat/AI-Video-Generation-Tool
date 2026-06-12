import {mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, mkdtempSync, statSync} from 'node:fs';
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
  it('type-flip FILE→DIR: src has FILE x, dst has DIR x with a child — mirror converges (dst x becomes the file) without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'typeflip-fd-'));
    const src = join(tmp, 'src'), dst = join(tmp, 'dst');
    mkdirSync(src, {recursive: true});
    // src has x as a FILE
    writeFileSync(join(src, 'x'), 'file-contents');
    // dst has x as a DIR with a child
    mkdirSync(join(dst, 'x'), {recursive: true});
    writeFileSync(join(dst, 'x', 'child.txt'), 'old');
    expect(() => mirrorTemplateAssets(src, dst)).not.toThrow();
    // after mirror, dst/x must be the FILE with src bytes
    expect(statSync(join(dst, 'x')).isFile()).toBe(true);
    expect(readFileSync(join(dst, 'x'), 'utf8')).toBe('file-contents');
    rmSync(tmp, {recursive: true, force: true});
  });
  it('type-flip DIR→FILE: src has DIR x with a child, dst has FILE x — mirror converges (dst x becomes the dir with child) without throwing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'typeflip-df-'));
    const src = join(tmp, 'src'), dst = join(tmp, 'dst');
    mkdirSync(src, {recursive: true});
    // src has x as a DIR with a child
    mkdirSync(join(src, 'x'), {recursive: true});
    writeFileSync(join(src, 'x', 'child.txt'), 'new');
    // dst has x as a FILE
    mkdirSync(dst, {recursive: true});
    writeFileSync(join(dst, 'x'), 'old-file');
    expect(() => mirrorTemplateAssets(src, dst)).not.toThrow();
    // after mirror, dst/x must be the DIR containing the child
    expect(statSync(join(dst, 'x')).isDirectory()).toBe(true);
    expect(existsSync(join(dst, 'x', 'child.txt'))).toBe(true);
    rmSync(tmp, {recursive: true, force: true});
  });
});
