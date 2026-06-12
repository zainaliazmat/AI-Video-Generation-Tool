// Mirror the renderer's public assets into preview/public/ so that
// staticFile("assets/...") resolves at the preview app's own origin (the
// Player serves from THIS app's public/, not remotion/public/).
// Idempotent; runs on predev/prebuild/prestart.
import {cpSync, mkdirSync, existsSync, readdirSync, rmSync, statSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// mirrorStock: one-way additive copy — NEVER deletes destination files.
// §15.7: runtime footage/voiceover files land in preview/public/assets/ and
// have no counterpart in remotion/public/assets/; deleting them breaks live
// previews (R3 regression guard).
// ---------------------------------------------------------------------------
export function mirrorStock(src, dst) {
  mkdirSync(dst, {recursive: true});
  if (existsSync(src)) {
    cpSync(src, dst, {recursive: true});
    console.log(`[copy-assets] assets -> ${dst}`);
  } else {
    console.warn(`[copy-assets] WARN: ${src} not found`);
  }
}

// ---------------------------------------------------------------------------
// mirrorTemplateAssets: MANAGED mirror — copies src into dst AND orphan-deletes
// any file/dir inside dst whose counterpart is absent from src.
// §15.7 scope constraint: ALL deletes are strictly confined to subtrees inside
// dst; this function NEVER touches any path outside the dst argument it receives.
// If src is missing entirely, dst (the whole namespace) is removed — a managed
// mirror of nothing is nothing.
// ---------------------------------------------------------------------------
export function mirrorTemplateAssets(src, dst) {
  if (!existsSync(src)) {
    rmSync(dst, {recursive: true, force: true});
    return;
  }
  // Copy src → dst first (creates new / overwrites changed).
  mkdirSync(dst, {recursive: true});
  cpSync(src, dst, {recursive: true});

  // Orphan-delete: walk dst, remove any entry with no src counterpart.
  // §15.7: deletions are STRICTLY scoped inside dst.
  function purgeOrphans(dstDir, srcDir) {
    for (const entry of readdirSync(dstDir)) {
      const dstEntry = join(dstDir, entry);
      const srcEntry = join(srcDir, entry);
      if (!existsSync(srcEntry)) {
        rmSync(dstEntry, {recursive: true, force: true});
      } else if (statSync(dstEntry).isDirectory()) {
        purgeOrphans(dstEntry, srcEntry);
      }
    }
  }
  purgeOrphans(dst, src);
  console.log(`[copy-assets] template-assets -> ${dst}`);
}

// ---------------------------------------------------------------------------
// Top-level execution (direct run or predev/prebuild/prestart hook).
// ---------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const previewRoot = resolve(__dirname, '..');
  const repoRoot = resolve(previewRoot, '..');
  const remotionPublic = resolve(repoRoot, 'remotion/public');
  const previewPublic = resolve(previewRoot, 'public');

  mkdirSync(previewPublic, {recursive: true});

  mirrorStock(
    resolve(remotionPublic, 'assets'),
    resolve(previewPublic, 'assets'),
  );
  mirrorTemplateAssets(
    resolve(remotionPublic, 'template-assets'),
    resolve(previewPublic, 'template-assets'),
  );
}
