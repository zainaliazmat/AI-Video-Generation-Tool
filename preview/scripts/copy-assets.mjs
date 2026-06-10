// Mirror the renderer's public assets into preview/public/ so that
// staticFile("assets/...") resolves at the preview app's own origin (the
// Player serves from THIS app's public/, not remotion/public/).
// Idempotent; runs on predev/prebuild/prestart.
import {cpSync, mkdirSync, existsSync} from 'node:fs';
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
