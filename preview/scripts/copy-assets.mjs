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

  // Purge-first: walk dst BEFORE copying and remove any entry whose src
  // counterpart is missing OR has a different type (file vs dir).  This
  // prevents cpSync from hitting ENOTSUP (src-file / dst-dir) or a native
  // SIGABRT (src-dir / dst-file) on Node 22 when types are flipped.
  // §15.7: ALL deletes are STRICTLY scoped inside dst; no path outside the
  // dst argument is ever touched.
  function purgeStaleOrTypeMismatched(dstDir, srcDir) {
    if (!existsSync(dstDir)) return;
    for (const entry of readdirSync(dstDir)) {
      const dstEntry = join(dstDir, entry);
      const srcEntry = join(srcDir, entry);
      if (!existsSync(srcEntry)) {
        // Orphan: no counterpart in src at all.
        rmSync(dstEntry, {recursive: true, force: true});
      } else {
        const dstStat = statSync(dstEntry);
        const srcStat = statSync(srcEntry);
        if (dstStat.isDirectory() !== srcStat.isDirectory()) {
          // Type mismatch (file↔dir): remove dst entry so cpSync can create
          // the correct type from scratch.
          rmSync(dstEntry, {recursive: true, force: true});
        } else if (dstStat.isDirectory()) {
          // Same type, both dirs: recurse to handle orphans/type-flips inside.
          purgeStaleOrTypeMismatched(dstEntry, srcEntry);
        }
        // Same type, both files: cpSync will overwrite — no action needed.
      }
    }
  }

  mkdirSync(dst, {recursive: true});
  purgeStaleOrTypeMismatched(dst, src);

  // Now cpSync is safe: no type conflicts remain in dst.
  cpSync(src, dst, {recursive: true});
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
