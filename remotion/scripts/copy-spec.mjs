// Stage the generated spec into public/ for the renderer. Prefers the real
// spec.json (override via SPEC_PATH), falls back to sample-spec.json so the
// Phase 1-3 skeleton still renders. Dest is always public/spec.json.
import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const remotionRoot = resolve(__dirname, '..');
const repoRoot = resolve(remotionRoot, '..');

const override = process.env.SPEC_PATH ? resolve(repoRoot, process.env.SPEC_PATH) : null;
const generated = resolve(repoRoot, 'spec.json');
const sample = resolve(repoRoot, 'sample-spec.json');
const src = [override, generated, sample].find((p) => p && existsSync(p));

if (!src) {
  console.error('[copy-spec] no spec.json or sample-spec.json found');
  process.exit(1);
}

const publicDir = resolve(remotionRoot, 'public');
mkdirSync(publicDir, {recursive: true});
copyFileSync(src, resolve(publicDir, 'spec.json'));
console.log(`[copy-spec] ${src} -> public/spec.json`);
