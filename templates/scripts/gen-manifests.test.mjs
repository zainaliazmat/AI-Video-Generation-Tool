import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, mkdtempSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(__dirname, '..');
const tsx = join(templatesDir, 'node_modules', '.bin', 'tsx');
const script = join(__dirname, 'gen-manifests.ts');

describe('gen-manifests --dir', () => {
  it('scans the given dir instead of templates/ (staging pin, §15.6)', () => {
    // NOTE: tmp dir is placed inside templates/.staging so node_modules
    // resolution from the copied schema.ts walks up to templates/node_modules
    // (zod lives there). A /tmp path breaks module resolution.
    const stagingDir = join(templatesDir, '.staging');
    mkdirSync(stagingDir, {recursive: true});
    const tmp = mkdtempSync(join(stagingDir, 'genman-'));
    const dir = join(tmp, 'demo-card');
    mkdirSync(dir, {recursive: true});
    cpSync(join(templatesDir, 'scene', 'schema.ts'), join(dir, 'schema.ts'));
    const scene = JSON.parse(readFileSync(join(templatesDir, 'scene', 'manifest.json'), 'utf8'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({...scene, id: 'demo-card', inputSchema: {}}, null, 2));
    execFileSync(tsx, [script, '--dir', tmp], {stdio: 'pipe'});
    const out = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(out.inputSchema).toEqual(scene.inputSchema); // regenerated from the same zod schema
    rmSync(tmp, {recursive: true, force: true});
  });
  it('R2: a no-flag run is byte-identical on the real tree', () => {
    const ids = ['hook', 'scene', 'stat', 'outro', 'overlay', 'enumeration'];
    const before = {};
    for (const id of ids) before[id] = readFileSync(join(templatesDir, id, 'manifest.json'), 'utf8');
    execFileSync(tsx, [script], {stdio: 'pipe'});
    for (const id of ids) {
      expect(readFileSync(join(templatesDir, id, 'manifest.json'), 'utf8')).toBe(before[id]);
    }
  });
});
