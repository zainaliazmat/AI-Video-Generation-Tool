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

const srcSpec = resolve(repoRoot, 'sample-spec.json');
const dstSpec = resolve(previewPublic, 'sample-spec.json');
if (existsSync(srcSpec)) {
  copyFileSync(srcSpec, dstSpec);
  console.log(`[copy-assets] sample-spec.json -> ${dstSpec}`);
} else {
  console.warn(`[copy-assets] WARN: ${srcSpec} not found`);
}
