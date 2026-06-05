// Mirror the renderer's public assets + the root spec into preview/public/ so
// that staticFile("assets/...") and fetch("/sample-spec.json") resolve at the
// preview app's own origin (the Player serves from THIS app's public/, not
// remotion/public/). Idempotent; runs on predev/prebuild/prestart.
import {cpSync, mkdirSync, copyFileSync, existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const previewRoot = resolve(__dirname, '..');
const repoRoot = resolve(previewRoot, '..');
const remotionPublic = resolve(repoRoot, 'remotion/public');
const previewPublic = resolve(previewRoot, 'public');

mkdirSync(previewPublic, {recursive: true});

const srcAssets = resolve(remotionPublic, 'assets');
const dstAssets = resolve(previewPublic, 'assets');
if (existsSync(srcAssets)) {
  cpSync(srcAssets, dstAssets, {recursive: true});
  console.log(`[copy-assets] assets -> ${dstAssets}`);
} else {
  console.warn(`[copy-assets] WARN: ${srcAssets} not found`);
}

const override = process.env.SPEC_PATH ? resolve(repoRoot, process.env.SPEC_PATH) : null;
const specCandidates = [override, resolve(repoRoot, 'spec.json'), resolve(repoRoot, 'sample-spec.json')];
const srcSpec = specCandidates.find((p) => p && existsSync(p));
const dstSpec = resolve(previewPublic, 'spec.json');
if (srcSpec) {
  copyFileSync(srcSpec, dstSpec);
  console.log(`[copy-assets] ${srcSpec} -> ${dstSpec}`);
} else {
  console.warn('[copy-assets] WARN: no spec.json or sample-spec.json found');
}
