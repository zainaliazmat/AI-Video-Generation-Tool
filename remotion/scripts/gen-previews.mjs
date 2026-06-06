// Auto-render a gallery preview per template (step 5.2).
//
// For each template it renders the `TemplatePreview` composition from the
// template's sampleProps into preview/public/previews/<id>.mp4 (a ~1.5s loop)
// + <id>.jpg (poster). "Drop a template in" → re-run this; the gallery picks it
// up. Idempotent + incremental: a template whose INPUTS are unchanged (and whose
// files exist) is skipped.
//
// FRESHNESS (`--check`): rendered MP4/JPG are NOT byte-stable across machines /
// ffmpeg versions, so we do NOT diff rendered bytes. Instead we hash each
// preview's INPUTS — the template's entry source (Component/presentation),
// its sampleProps, and the TemplatePreview harness source (which carries the
// preview theme + durations) — and store them in previews.lock.json. `--check`
// recomputes the hashes and fails if any input changed without a regenerated
// preview, or a preview file is missing. (This differs from the manifest
// JSON-Schema check, which CAN regenerate-and-diff because JSON Schema is
// deterministic text.)
import {readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const remotionDir = resolve(__dirname, '..');
const repoRoot = resolve(remotionDir, '..');
const templatesDir = resolve(repoRoot, 'templates');
const previewsDir = resolve(repoRoot, 'preview', 'public', 'previews');
const harnessSrc = resolve(remotionDir, 'src', 'TemplatePreview.tsx');
const lockPath = join(previewsDir, 'previews.lock.json');

// Poster frame per kind (settled-ish for render; mid-blend for a transition so
// the thumbnail reads as motion). Kept conservative vs the composition lengths.
const POSTER_FRAME = {render: 36, transition: 35};

function discover() {
  const harness = readFileSync(harnessSrc, 'utf8');
  const out = [];
  for (const entry of readdirSync(templatesDir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === 'scripts' || entry.name === 'node_modules') continue;
    const dir = join(templatesDir, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const isTransition = manifest.kind === 'transition';
    const entryPath = isTransition ? join(dir, 'presentation.tsx') : join(dir, 'Component.tsx');
    if (!existsSync(entryPath)) continue;
    const inputHash = createHash('sha256')
      .update(readFileSync(entryPath, 'utf8'))
      .update(JSON.stringify(manifest.sampleProps ?? {}))
      .update(harness)
      .digest('hex')
      .slice(0, 16);
    out.push({id: manifest.id, kind: isTransition ? 'transition' : 'render', sampleProps: manifest.sampleProps ?? {}, inputHash});
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function readLock() {
  if (!existsSync(lockPath)) return {};
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return {};
  }
}

function previewFiles(id) {
  return {mp4: join(previewsDir, `${id}.mp4`), jpg: join(previewsDir, `${id}.jpg`)};
}

function staleList(templates, lock) {
  const stale = [];
  for (const t of templates) {
    const {mp4, jpg} = previewFiles(t.id);
    if (lock[t.id] !== t.inputHash || !existsSync(mp4) || !existsSync(jpg)) stale.push(t);
  }
  return stale;
}

function check() {
  const templates = discover();
  const lock = readLock();
  const stale = staleList(templates, lock);
  // Also flag lock entries whose template no longer exists.
  const ids = new Set(templates.map((t) => t.id));
  const orphans = Object.keys(lock).filter((id) => !ids.has(id));
  if (stale.length === 0 && orphans.length === 0) {
    console.log(`[gen-previews --check] OK — ${templates.length} preview(s) fresh`);
    return;
  }
  if (stale.length) console.error(`[gen-previews --check] STALE/MISSING: ${stale.map((t) => t.id).join(', ')}`);
  if (orphans.length) console.error(`[gen-previews --check] ORPHAN lock entries: ${orphans.join(', ')}`);
  console.error('Run `npm run gen-previews` and commit preview/public/previews/.');
  process.exit(1);
}

function renderOne(t) {
  const {mp4, jpg} = previewFiles(t.id);
  const props = JSON.stringify({templateId: t.id, props: t.sampleProps});
  const common = ['--log=error', `--props=${props}`];
  // MP4 loop
  execFileSync('npx', ['remotion', 'render', 'TemplatePreview', mp4, ...common], {
    cwd: remotionDir, stdio: 'inherit',
  });
  // Poster still
  execFileSync('npx', ['remotion', 'still', 'TemplatePreview', jpg, `--frame=${POSTER_FRAME[t.kind]}`, ...common], {
    cwd: remotionDir, stdio: 'inherit',
  });
}

function generate() {
  mkdirSync(previewsDir, {recursive: true});
  const templates = discover();
  const lock = readLock();
  const stale = staleList(templates, lock);
  if (stale.length === 0) {
    console.log(`[gen-previews] all ${templates.length} preview(s) up to date — nothing to render`);
    return;
  }
  console.log(`[gen-previews] rendering ${stale.length}/${templates.length}: ${stale.map((t) => t.id).join(', ')}`);
  for (const t of stale) {
    console.log(`[gen-previews] ${t.id} (${t.kind})...`);
    renderOne(t);
  }
  // Rewrite the lock from the FULL current set (drops orphans).
  const next = {};
  for (const t of templates) next[t.id] = t.inputHash;
  writeFileSync(lockPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`[gen-previews] done — ${stale.length} rendered, lock updated (${templates.length} total)`);
}

if (process.argv.includes('--check')) check();
else generate();
