// Template installer engine — §15.2 verify-before-register pipeline.
//
// This module owns: lock, last-error, startup-sweep, template discovery,
// public state surface, reference scan, and the CLI shell.
//
// The pure validation stages (unpack → envelope → contract → id → compat →
// schema) live in install-stages.mjs, extracted (Fix 2) to keep this file
// navigable as Task 10 adds typecheck → register → preview → rollback.
//
// Lock contract (§15.2): a single JSON file at STAGING_DIR/.lock holds
// {pid, op, startedAt}. Only one install/uninstall/doctor op may hold the
// lock at a time. A lock held by a dead pid is considered stale and is
// silently replaced. Lock conflicts throw InstallError('lock', ..., 409).
//
// Last-error contract (§16.15-2): STAGING_DIR/last-error.json sits "beside
// the lock". It is written on any stage failure so the operator/UI always
// has a readable post-mortem. A corrupt file reads as null — never throws.
//
// Sentinel contract (§15.2): a templates/<id>/.installing file marks a
// folder as mid-install. Such folders are INVISIBLE to the registry and
// are swept on startup. This closes the crash window where a partial install
// would pollute the registry.
//
// All exports are pure-ish (no global side-effects at import time) so the
// vitest suite can import freely. Future API routes (§16.15-4) call the same
// exported functions directly.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  cpSync,
  renameSync,
  statSync,
} from 'node:fs';
import {resolve, join, relative, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Shared (async, non-blocking) default runners — single source of truth (I-1/I-2).
import {defaultRunners as _sharedDefaultRunners} from './install-runners.mjs';

// ---------------------------------------------------------------------------
// Re-export path constants + InstallError from shared module (backward compat)
// ---------------------------------------------------------------------------

export {
  TEMPLATES_DIR,
  SCRIPTS_DIR,
  STAGING_DIR,
  LOCK_PATH,
  LAST_ERROR_PATH,
  REPO_ROOT,
  REMOTION_DIR,
  RENDER_ASSETS_DIR,
  PREVIEWS_DIR,
  InstallError,
} from './install-paths.mjs';

import {
  TEMPLATES_DIR,
  SCRIPTS_DIR,
  STAGING_DIR,
  LOCK_PATH,
  LAST_ERROR_PATH,
  REPO_ROOT,
  REMOTION_DIR,
  RENDER_ASSETS_DIR,
  PREVIEWS_DIR,
  InstallError,
} from './install-paths.mjs';

/** marketplace/ directory — the local store of available packages. */
export const MARKETPLACE_DIR = resolve(REPO_ROOT, 'marketplace');

// ---------------------------------------------------------------------------
// Re-export validation stages + helpers from install-stages.mjs (backward compat)
// ---------------------------------------------------------------------------

export {
  SUPPORTED_API_VERSION,
  _isValidId,
  _stageUnpack,
  _stageEnvelope,
  _stageContract,
  _stageId,
  _stageCompat,
  _stageSchema,
  _runValidation,
} from './install-stages.mjs';

// Also import locally so install()/doctor() can call _runValidation directly.
import {_runValidation} from './install-stages.mjs';

// ---------------------------------------------------------------------------
// Single-flight lock (§15.2)
// ---------------------------------------------------------------------------

/**
 * Acquire the single-flight lock for operation `op`.
 *
 * Uses the O_EXCL trick: writeFileSync with flag:'wx' succeeds atomically
 * only when the file does not already exist. On EEXIST we read the existing
 * lock, probe the pid, and either throw (alive) or overwrite (stale/dead).
 *
 * @param {string} op  Operation name, stored in the lock payload for diagnostics.
 * @throws {InstallError} stage='lock', statusCode=409 when a live pid holds the lock.
 */
export function _acquireLock(op) {
  mkdirSync(STAGING_DIR, {recursive: true});
  const payload = JSON.stringify({pid: process.pid, op, startedAt: new Date().toISOString()});
  try {
    writeFileSync(LOCK_PATH, payload, {flag: 'wx'});
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Lock file already exists — check if the holding pid is alive.
    let existing;
    try {
      existing = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    } catch {
      // Corrupt lock file — treat as stale, overwrite.
      writeFileSync(LOCK_PATH, payload);
      return;
    }
    const holdingPid = existing && typeof existing.pid === 'number' ? existing.pid : null;
    if (holdingPid !== null) {
      // Same-process re-entrancy counts as "live" — single-flight means one op
      // at a time even within the same process (e.g. test suite calling twice).
      let alive = holdingPid === process.pid;
      if (!alive) {
        try {
          process.kill(holdingPid, 0); // signal 0 = probe: throws ESRCH if dead
          alive = true;
        } catch (err) {
          // ESRCH = no such process (dead). EPERM = alive but owned by another
          // user — can't be tested cross-user in this suite, but must not be
          // treated as dead.
          alive = err.code !== 'ESRCH';
        }
      }
      if (alive) {
        throw new InstallError('lock', 'An install is already running — one at a time.', {statusCode: 409});
      }
    }
    // Stale or dead-pid lock — overwrite.
    writeFileSync(LOCK_PATH, payload);
  }
}

/**
 * Release the lock by removing the lock file.
 * Idempotent — safe to call even if not currently held.
 */
export function _releaseLock() {
  rmSync(LOCK_PATH, {force: true});
}

// ---------------------------------------------------------------------------
// Last-error surface (§16.15-2)
// ---------------------------------------------------------------------------

/**
 * Persist a structured error record beside the lock file.
 * Adds an `at` ISO timestamp. Never throws.
 *
 * @param {{op: string, id: string, stage: string, message: string}} params
 */
export function _writeLastError({op, id, stage, message}) {
  mkdirSync(STAGING_DIR, {recursive: true});
  const record = {op, id, stage, message, at: new Date().toISOString()};
  try {
    writeFileSync(LAST_ERROR_PATH, JSON.stringify(record, null, 2));
  } catch {
    // Best-effort — a failure to write the error record must never mask the
    // original failure.
  }
}

/**
 * Remove the last-error file so installedState().lastError returns null.
 * Idempotent.
 */
export function clearLastError() {
  rmSync(LAST_ERROR_PATH, {force: true});
}

/**
 * Read the last-error record. Returns null if missing or corrupt.
 * @returns {object|null}
 */
function _readLastError() {
  if (!existsSync(LAST_ERROR_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LAST_ERROR_PATH, 'utf8'));
  } catch {
    return null; // corrupt file — never throws
  }
}

// ---------------------------------------------------------------------------
// Startup sweep (§15.2)
// ---------------------------------------------------------------------------

/**
 * Remove mid-install artefacts left by a crashed previous run:
 *   1. templates/* folders bearing a `.installing` sentinel.
 *   2. Stale run-dirs inside STAGING_DIR (directories only — never .lock /
 *      last-error.json files).
 *
 * Called at installer startup before taking the lock.
 */
export function _sweepStale() {
  // 1. Remove templates/* folders bearing .installing.
  if (existsSync(TEMPLATES_DIR)) {
    for (const entry of readdirSync(TEMPLATES_DIR, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'scripts' || entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.')) continue;
      const dir = join(TEMPLATES_DIR, entry.name);
      if (existsSync(join(dir, '.installing'))) {
        rmSync(dir, {recursive: true, force: true});
      }
    }
  }

  // 2. Remove stale run-dirs from STAGING_DIR.
  //    Determine whether a live lock is held — if so, be conservative and
  //    skip removing dirs (the running op may be using them).
  if (!existsSync(STAGING_DIR)) return;

  let liveLockPid = null;
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    if (lock && typeof lock.pid === 'number') {
      try {
        process.kill(lock.pid, 0);
        liveLockPid = lock.pid; // pid is alive
      } catch {
        // dead pid — no live lock
      }
    }
  } catch {
    // no lock or corrupt — no live lock
  }

  // Don't sweep while a live op is running, UNLESS that live op is this
  // process itself (engine driver calls _acquireLock then _sweepStale).
  if (liveLockPid !== null && liveLockPid !== process.pid) return;

  for (const entry of readdirSync(STAGING_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue; // never remove .lock / last-error.json files
    rmSync(join(STAGING_DIR, entry.name), {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// Template discovery (shared by listInstalled / installedState)
// ---------------------------------------------------------------------------

/**
 * @typedef {{id: string, version: string, kind: string, author: string, description: string}} TemplateInfo
 */

/**
 * Internal shape returned by _discoverInstalled — adds `folder` (the actual
 * on-disk directory name) used by installedState() to derive the git path.
 * The `folder` field is NOT part of the public surface.
 *
 * @typedef {TemplateInfo & {folder: string}} DiscoveredTemplate
 */

/**
 * Scan templates/ and return metadata for every properly-installed template.
 *
 * Skips:
 *   - non-directories
 *   - 'scripts', 'node_modules'
 *   - dot-named entries (§17.4: staging/dot dirs are never templates)
 *   - folders bearing a `.installing` sentinel (§15.2 crash-window)
 *   - folders without a manifest.json
 *   - folders whose manifest.json is unparseable (warns to stderr, skips)
 *
 * @returns {DiscoveredTemplate[]} sorted by id
 */
function _discoverInstalled() {
  const found = [];
  for (const entry of readdirSync(TEMPLATES_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'scripts' || entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue;
    const dir = join(TEMPLATES_DIR, entry.name);
    // §15.2: mid-install sentinel — folder is scanner-invisible
    if (existsSync(join(dir, '.installing'))) continue;
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.warn(`[install] skipping ${entry.name}/manifest.json — parse error: ${err.message}`);
      continue;
    }
    found.push({
      id: manifest.id ?? entry.name,
      version: manifest.version ?? '0.0.0',
      kind: manifest.kind ?? 'scene',
      author: manifest.author ?? 'unknown',
      description: manifest.description ?? '',
      folder: entry.name, // actual on-disk name — used by installedState() for git path
    });
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

// ---------------------------------------------------------------------------
// Public state surface (§16.15-4)
// ---------------------------------------------------------------------------

/**
 * Return a lightweight list of installed templates (no git-status overhead).
 * @returns {TemplateInfo[]}
 */
export function listInstalled() {
  return _discoverInstalled();
}

/**
 * Return the full installer state surface.
 *
 * `uncommitted` is derived EXACTLY from `git status --porcelain` per §16.11:
 * non-empty output ⇒ true.
 *
 * @returns {{
 *   installedIds: string[],
 *   templates: Array<TemplateInfo & {uncommitted: boolean}>,
 *   lastError: object|null
 * }}
 */
export function installedState() {
  const discovered = _discoverInstalled();
  const templates = discovered.map((t) => {
    let uncommitted = false;
    try {
      // Use the actual folder name (not manifest.id) so that a template whose
      // folder was renamed after installation isn't silently reported as clean.
      const out = execFileSync(
        'git',
        ['status', '--porcelain', '--', `templates/${t.folder}`],
        {cwd: REPO_ROOT, encoding: 'utf8'},
      );
      uncommitted = out.trim().length > 0;
    } catch {
      // git not available or not a git repo — treat as committed
      uncommitted = false;
    }
    // Strip the internal `folder` field — public shape is id/version/kind/author/description/uncommitted.
    const {folder: _folder, ...pub} = t;
    return {...pub, uncommitted};
  });
  return {
    installedIds: templates.map((t) => t.id),
    templates,
    lastError: _readLastError(),
  };
}

// ---------------------------------------------------------------------------
// Reference scan (§15.9/§17.1)
// ---------------------------------------------------------------------------

/**
 * Scan all spec.json files for references to `id`.
 *
 * Coverage: `scenes[].template`, `scenes[].transition?.template`,
 * `layers[].template` — across `projects/<each>/spec.json` and the root
 * `spec.json` when present.
 *
 * Corrupt or unreadable spec files are silently skipped — never throws.
 *
 * @param {string} id  Template id to search for.
 * @returns {{total: number, files: Array<{path: string, count: number}>}}
 *   `path` is relative to REPO_ROOT; `files` contains only entries with
 *   count > 0.
 */
export function scanReferences(id) {
  const candidates = [];

  // projects/<each>/spec.json
  const projectsDir = join(REPO_ROOT, 'projects');
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      candidates.push(join(projectsDir, entry.name, 'spec.json'));
    }
  }

  // root spec.json (runtime-generated, may or may not exist)
  const rootSpec = join(REPO_ROOT, 'spec.json');
  if (existsSync(rootSpec)) {
    candidates.push(rootSpec);
  }

  const files = [];
  let total = 0;

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    let spec;
    try {
      spec = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      continue; // skip corrupt/unreadable files
    }
    let count = 0;
    for (const scene of spec.scenes ?? []) {
      if (scene.template === id) count++;
      if (scene.transition?.template === id) count++;
    }
    for (const layer of spec.layers ?? []) {
      if (layer.template === id) count++;
    }
    if (count > 0) {
      files.push({path: relative(REPO_ROOT, filePath), count});
      total += count;
    }
  }

  return {total, files};
}

// ---------------------------------------------------------------------------
// Default runners (§15.2)
// ---------------------------------------------------------------------------

/**
 * Default runner implementations for the heavy pipeline stages.
 *
 * Defined ONCE in install-runners.mjs (I-2) and re-exported here so the public
 * surface (`import {_defaultRunners} from './install.mjs'`) is unchanged. All
 * five runners are async/non-blocking (I-1) so install() inside an M4 SSE route
 * can keep emitting keep-alive frames while tsc/preview run.
 *
 * Replaceable per-call via opts.runners so the test suite can stub heavy stages
 * (tsc / preview / copyAssets) while still running the REAL buildRegistry so
 * registry assertions work. The genManifests entry is the SAME function object
 * that install-stages.mjs's _stageSchema falls back to — no byte-duplication.
 */
export const _defaultRunners = _sharedDefaultRunners;

// ---------------------------------------------------------------------------
// Ship-assets helper (§15.2)
// ---------------------------------------------------------------------------

/**
 * Copy all declared manifest.assets PLUS CREDITS.json to
 * RENDER_ASSETS_DIR/<id>/.
 *
 * CREDITS.json is always copied when it exists in assets/ — it may not be
 * listed in manifest.assets (§4.4 only requires it when non-CREDITS assets
 * ship), but it is always safe to mirror.
 *
 * @param {string} tplDir  templates/<id> (already renamed, sentinel still present).
 * @param {object} manifest
 */
function _shipAssets(tplDir, manifest) {
  const id = manifest.id;
  const destDir = join(RENDER_ASSETS_DIR, id);
  mkdirSync(destDir, {recursive: true});

  const toCopy = new Set(manifest.assets ?? []);

  // Always include CREDITS.json when present
  const creditsRel = 'assets/CREDITS.json';
  const creditsAbs = join(tplDir, creditsRel);
  if (existsSync(creditsAbs)) toCopy.add(creditsRel);

  for (const rel of toCopy) {
    const src = join(tplDir, rel);
    // Strip leading 'assets/' — we flatten into RENDER_ASSETS_DIR/<id>/
    const basename = rel.replace(/^assets\//, '');
    const dest = join(destDir, basename);
    mkdirSync(dirname(dest), {recursive: true});
    if (existsSync(src)) {
      cpSync(src, dest, {recursive: false, force: true});
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot / restore helpers (§15.2 update path)
// ---------------------------------------------------------------------------

/**
 * Take snapshots of template folder, assets, and preview files + lock entry
 * before an update install so they can be restored on failure.
 *
 * @param {string} id
 * @param {string} runId  Used to name the snapshot dirs inside STAGING_DIR.
 * @returns {{snapshotDir: string|null, snapshotAssetsDir: string|null, snapshotPreviewsDir: string|null, lockEntry: string|null}}
 */
function _snapshotForUpdate(id, runId) {
  const tplInstallDir = join(TEMPLATES_DIR, id);
  const assetsDir = join(RENDER_ASSETS_DIR, id);
  const previewsLockPath = join(PREVIEWS_DIR, 'previews.lock.json');

  let snapshotDir = null;
  if (existsSync(tplInstallDir)) {
    snapshotDir = join(STAGING_DIR, `${runId}-snapshot`);
    mkdirSync(snapshotDir, {recursive: true});
    cpSync(tplInstallDir, join(snapshotDir, id), {recursive: true});
  }

  let snapshotAssetsDir = null;
  if (existsSync(assetsDir)) {
    snapshotAssetsDir = join(STAGING_DIR, `${runId}-snapshot-assets`);
    mkdirSync(snapshotAssetsDir, {recursive: true});
    cpSync(assetsDir, join(snapshotAssetsDir, id), {recursive: true});
  }

  let snapshotPreviewsDir = null;
  const mp4 = join(PREVIEWS_DIR, `${id}.mp4`);
  const jpg = join(PREVIEWS_DIR, `${id}.jpg`);
  if (existsSync(mp4) || existsSync(jpg)) {
    snapshotPreviewsDir = join(STAGING_DIR, `${runId}-snapshot-previews`);
    mkdirSync(snapshotPreviewsDir, {recursive: true});
    if (existsSync(mp4)) cpSync(mp4, join(snapshotPreviewsDir, `${id}.mp4`));
    if (existsSync(jpg)) cpSync(jpg, join(snapshotPreviewsDir, `${id}.jpg`));
  }

  // Snapshot the lock entry value
  let lockEntry = null;
  try {
    const lock = JSON.parse(readFileSync(previewsLockPath, 'utf8'));
    lockEntry = lock[id] ?? null;
  } catch { /* lock missing or corrupt — fine */ }

  return {snapshotDir, snapshotAssetsDir, snapshotPreviewsDir, lockEntry};
}

/**
 * Restore from update snapshots on install failure.
 *
 * @param {string} id
 * @param {{snapshotDir: string|null, snapshotAssetsDir: string|null, snapshotPreviewsDir: string|null, lockEntry: string|null}} snap
 */
function _restoreSnapshot(id, snap) {
  const {snapshotDir, snapshotAssetsDir, snapshotPreviewsDir, lockEntry} = snap;

  // Remove the partially-installed folder and replace with snapshot
  rmSync(join(TEMPLATES_DIR, id), {recursive: true, force: true});
  if (snapshotDir && existsSync(join(snapshotDir, id))) {
    cpSync(join(snapshotDir, id), join(TEMPLATES_DIR, id), {recursive: true});
  }

  // Restore assets
  rmSync(join(RENDER_ASSETS_DIR, id), {recursive: true, force: true});
  if (snapshotAssetsDir && existsSync(join(snapshotAssetsDir, id))) {
    mkdirSync(join(RENDER_ASSETS_DIR, id), {recursive: true});
    cpSync(join(snapshotAssetsDir, id), join(RENDER_ASSETS_DIR, id), {recursive: true});
  }

  // Restore previews
  rmSync(join(PREVIEWS_DIR, `${id}.mp4`), {force: true});
  rmSync(join(PREVIEWS_DIR, `${id}.jpg`), {force: true});
  if (snapshotPreviewsDir) {
    const snapMp4 = join(snapshotPreviewsDir, `${id}.mp4`);
    const snapJpg = join(snapshotPreviewsDir, `${id}.jpg`);
    if (existsSync(snapMp4)) cpSync(snapMp4, join(PREVIEWS_DIR, `${id}.mp4`));
    if (existsSync(snapJpg)) cpSync(snapJpg, join(PREVIEWS_DIR, `${id}.jpg`));
  }

  // Restore lock entry
  const previewsLockPath = join(PREVIEWS_DIR, 'previews.lock.json');
  try {
    let lock = {};
    try { lock = JSON.parse(readFileSync(previewsLockPath, 'utf8')); } catch { /* */ }
    if (lockEntry !== null) {
      lock[id] = lockEntry;
    } else {
      delete lock[id];
    }
    writeFileSync(previewsLockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// install() — verify-before-register pipeline (§15.2)
// ---------------------------------------------------------------------------

/**
 * Install a template from a zip or directory source.
 *
 * Stage order (§15.2 contract — implement verbatim):
 *   sha256 pre-check (if opts.sha256 set) → _runValidation (stages 1–5) →
 *   snapshot (if updating) → write .installing sentinel → atomic rename →
 *   tsc → shipAssets → rm .installing → buildRegistry →
 *   genPreviews → copyAssets → clearLastError
 *
 * Crash-window honesty: the sentinel is removed immediately BEFORE the
 * register (build-registry) call. It cannot survive into registration.
 * The residual window (crash between sentinel-rm and preview-pass) leaves a
 * registered-but-unsmoked template; the spec accepts this and the startup
 * sweep + the next predev build-registry cover the wider window.
 *
 * @param {string} srcZipOrDir
 * @param {{
 *   sha256?: string,
 *   update?: boolean,
 *   confirmReplace?: boolean,
 *   overrideCapability?: boolean,
 *   runners?: Partial<typeof _defaultRunners>
 * }} opts
 */
export async function install(srcZipOrDir, opts = {}) {
  const runners = {..._defaultRunners, ...opts.runners};
  let id = null;
  let runDir = null;
  let snap = null;

  // sha256 pre-check (§15.14) — file sources only
  if (opts.sha256 !== undefined) {
    let st;
    try { st = statSync(srcZipOrDir); } catch { st = null; }
    if (st && st.isDirectory()) {
      throw new InstallError('integrity', 'sha256 check is not supported for directory sources — provide a zip file');
    }
    if (st) {
      const actual = createHash('sha256').update(readFileSync(srcZipOrDir)).digest('hex');
      if (actual !== opts.sha256) {
        throw new InstallError(
          'integrity',
          `sha256 mismatch — refusing to install (expected ${opts.sha256}, got ${actual})`,
        );
      }
    }
  }

  _acquireLock('install');
  try {
    _sweepStale();

    // Stages 1–5
    const {runDir: rd, tplDir, manifest, existing} = await _runValidation(srcZipOrDir, {
      update: opts.update,
      confirmReplace: opts.confirmReplace,
      overrideCapability: opts.overrideCapability,
      runners: opts.runners ?? {},
    });
    runDir = rd;
    id = manifest.id;

    // Snapshot before overwriting (update path)
    const runId = `run-${process.pid}`;
    if (existing) {
      snap = _snapshotForUpdate(id, runId);
    }

    // Write .installing sentinel INTO the staged folder
    writeFileSync(join(tplDir, '.installing'), 'installing');

    // Atomic publish: rename staged folder to templates/<id>
    const installDir = join(TEMPLATES_DIR, id);
    // If updating, remove the old dir first (rename would fail on POSIX if dest non-empty)
    if (existing) {
      rmSync(installDir, {recursive: true, force: true});
    }
    renameSync(tplDir, installDir);

    // tsc check — failure → restore (update) + rethrow
    try {
      await runners.tsc();
    } catch (err) {
      rmSync(installDir, {recursive: true, force: true});
      if (snap) _restoreSnapshot(id, snap);
      // buildRegistry NOT called — template was never registered
      const msg = err.message || String(err);
      throw new InstallError('typecheck', msg.slice(0, 2000));
    }

    // Ship declared assets + CREDITS.json to RENDER_ASSETS_DIR/<id>/
    _shipAssets(installDir, manifest);

    // Remove .installing sentinel BEFORE registration
    // (Crash-window: see module header comment above)
    rmSync(join(installDir, '.installing'), {force: true});

    // Register — build-registry regenerates registry.generated.ts
    await runners.buildRegistry();

    // Smoke render — failure → full rollback
    try {
      await runners.genPreviews(id);
    } catch (err) {
      // ROLLBACK: remove installed folder + assets + preview candidate
      rmSync(installDir, {recursive: true, force: true});
      rmSync(join(RENDER_ASSETS_DIR, id), {recursive: true, force: true});
      rmSync(join(PREVIEWS_DIR, `${id}.mp4`), {force: true});
      rmSync(join(PREVIEWS_DIR, `${id}.jpg`), {force: true});
      if (snap) _restoreSnapshot(id, snap);
      await runners.buildRegistry();
      await runners.copyAssets();
      throw new InstallError('preview', err.message || String(err));
    }

    // Install is fully committed at this point — clear any previous error before
    // the best-effort preview mirror so a copyAssets hiccup doesn't look like a
    // failed install.
    clearLastError();

    // Mirror template-assets into preview/public/ (best-effort — the template
    // is already registered and live; run `npm run copy-assets` in preview/ to
    // refresh manually if this step fails).
    try {
      await runners.copyAssets();
    } catch (e) {
      console.warn('[install] preview mirror copy-assets failed post-install — run `npm run copy-assets` in preview/ to refresh; install itself succeeded: ' + e.message);
    }

    return {
      id,
      version: manifest.version,
      kind: manifest.kind,
      preview: `previews/${id}.mp4`,
      updated: existing ? {from: existing.version} : null,
    };
  } catch (e) {
    _writeLastError({op: 'install', id, stage: e.stage ?? 'install', message: e.message});
    throw e;
  } finally {
    // Best-effort cleanup of runDir and snapshot dirs
    if (runDir) rmSync(runDir, {recursive: true, force: true});
    if (snap) {
      if (snap.snapshotDir) rmSync(snap.snapshotDir, {recursive: true, force: true});
      if (snap.snapshotAssetsDir) rmSync(snap.snapshotAssetsDir, {recursive: true, force: true});
      if (snap.snapshotPreviewsDir) rmSync(snap.snapshotPreviewsDir, {recursive: true, force: true});
    }
    _releaseLock();
  }
}

// ---------------------------------------------------------------------------
// installFromMarketplace() — thin resolver (§6/§7)
// ---------------------------------------------------------------------------

/**
 * Install a template by id from the local marketplace catalog.
 *
 * Reads marketplace/index.json, finds the entry by id, resolves the zip path,
 * and delegates to install() with the catalog sha256 as the integrity gate.
 * The existing install() sha256 pre-check is the only integrity check — no
 * second install path.
 *
 * @param {string} id  Marketplace package id.
 * @param {{
 *   update?: boolean,
 *   confirmReplace?: boolean,
 *   runners?: Partial<typeof _defaultRunners>
 * }} opts
 */
export async function installFromMarketplace(id, opts = {}) {
  // Read the catalog
  const indexPath = join(MARKETPLACE_DIR, 'index.json');
  let catalog = {packages: []};
  if (existsSync(indexPath)) {
    try {
      catalog = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch (e) {
      throw new InstallError('unpack', `cannot read marketplace/index.json: ${e.message}`);
    }
  }

  // Find the entry
  const entry = (catalog.packages ?? []).find((p) => p.id === id);
  if (!entry) {
    throw new InstallError(
      'id',
      `no marketplace package "${id}" in the catalog — run build-marketplace-index or check the id`,
    );
  }

  // Resolve zip path — containment guard (defense for M4/M6 index serving)
  const zipPath = join(MARKETPLACE_DIR, entry.package);
  if (!zipPath.startsWith(resolve(MARKETPLACE_DIR) + sep)) {
    throw new InstallError('integrity', `marketplace entry "${id}" resolves outside the store`);
  }
  if (!existsSync(zipPath)) {
    throw new InstallError(
      'unpack',
      `marketplace package zip missing: ${entry.package} — run: node templates/scripts/build-marketplace-index.mjs`,
    );
  }

  // Delegate to install() with the catalog sha256 as the integrity gate.
  return install(zipPath, {
    sha256: entry.sha256,
    update: opts.update,
    confirmReplace: opts.confirmReplace,
    runners: opts.runners,
  });
}

// ---------------------------------------------------------------------------
// uninstall() — §15.9
// ---------------------------------------------------------------------------

/**
 * Uninstall a template by id.
 *
 * Protected: core templates (author === 'core') cannot be uninstalled.
 * Returns {id, removed: true, referencedBy} — referencedBy.total may be > 0
 * (the caller/UI decides whether to warn the user; we uninstall either way).
 *
 * @param {string} id
 * @param {{runners?: Partial<typeof _defaultRunners>}} opts
 */
export async function uninstall(id, opts = {}) {
  const runners = {..._defaultRunners, ...opts.runners};
  _acquireLock('uninstall');
  try {
    _sweepStale();

    const manifestPath = join(TEMPLATES_DIR, id, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new InstallError('uninstall', `no template "${id}" installed`);
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new InstallError('uninstall', `cannot read manifest for "${id}": ${e.message}`);
    }

    if (manifest.author === 'core') {
      throw new InstallError('uninstall', `"${id}" is a core template — protected, cannot uninstall`);
    }

    const refs = scanReferences(id);

    // Remove everything
    rmSync(join(TEMPLATES_DIR, id), {recursive: true, force: true});
    rmSync(join(RENDER_ASSETS_DIR, id), {recursive: true, force: true});
    rmSync(join(PREVIEWS_DIR, `${id}.mp4`), {force: true});
    rmSync(join(PREVIEWS_DIR, `${id}.jpg`), {force: true});

    // Drop lock entry from previews.lock.json (tolerate missing/corrupt)
    const lockPath = join(PREVIEWS_DIR, 'previews.lock.json');
    try {
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        delete lock[id];
        writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
      }
    } catch { /* best-effort */ }

    await runners.buildRegistry();
    await runners.copyAssets();
    clearLastError();

    return {id, removed: true, referencedBy: refs};
  } catch (e) {
    _writeLastError({op: 'uninstall', id, stage: e.stage ?? 'uninstall', message: e.message});
    throw e;
  } finally {
    _releaseLock();
  }
}

// ---------------------------------------------------------------------------
// doctor() — §15.2 dry-run: same pipeline as install, guaranteed rollback
// ---------------------------------------------------------------------------

/**
 * Run the full install pipeline (stages 1–7: validate + tsc + preview) as a
 * dry-run — always rolls back on both success AND failure, leaving zero
 * residue in templates/, RENDER_ASSETS_DIR, and preview files.
 *
 * Doctor treats an already-installed id as an update (update+confirmReplace
 * internally) so an author re-running doctor on an installed template doesn't
 * trip the collision gate.
 *
 * Returns {ok:true, id, version, kind} on success, throws the stage error on
 * failure (after rollback in both cases).
 *
 * "doctor-clean == installable" is the contract: doctor reaches real tsc +
 * real preview render by default — the same stages as install.
 *
 * @param {string} srcZipOrDir
 * @param {{runners?: Partial<typeof _defaultRunners>}} opts
 */
export async function doctor(srcZipOrDir, opts = {}) {
  const runners = {..._defaultRunners, ...opts.runners};
  let id = null;
  let runDir = null;
  let snap = null;

  _acquireLock('doctor');
  try {
    _sweepStale();

    // Stages 1–5 with implicit update+confirmReplace so an installed id
    // doesn't hit the collision gate.
    const {runDir: rd, tplDir, manifest, existing} = await _runValidation(srcZipOrDir, {
      update: true,
      confirmReplace: true,
      runners: opts.runners ?? {},
    });
    runDir = rd;
    id = manifest.id;

    // Snapshot any existing installation so we can restore unconditionally
    const runId = `doctor-${process.pid}`;
    snap = _snapshotForUpdate(id, runId);

    try {
      // Write sentinel and rename into place
      writeFileSync(join(tplDir, '.installing'), 'installing');
      const installDir = join(TEMPLATES_DIR, id);
      if (existing) rmSync(installDir, {recursive: true, force: true});
      renameSync(tplDir, installDir);

      // tsc
      try {
        await runners.tsc();
      } catch (err) {
        const msg = err.message || String(err);
        throw new InstallError('typecheck', msg.slice(0, 2000));
      }

      // Ship assets
      _shipAssets(installDir, manifest);

      // Remove sentinel
      rmSync(join(installDir, '.installing'), {force: true});

      // buildRegistry
      await runners.buildRegistry();

      // genPreviews
      try {
        await runners.genPreviews(id);
      } catch (err) {
        throw new InstallError('preview', err.message || String(err));
      }
    } finally {
      // UNCONDITIONAL rollback — doctor NEVER leaves residue
      const installDir = join(TEMPLATES_DIR, id);
      rmSync(installDir, {recursive: true, force: true});
      rmSync(join(RENDER_ASSETS_DIR, id), {recursive: true, force: true});
      rmSync(join(PREVIEWS_DIR, `${id}.mp4`), {force: true});
      rmSync(join(PREVIEWS_DIR, `${id}.jpg`), {force: true});
      if (snap) _restoreSnapshot(id, snap);
      // Rebuild registry + mirror assets to restore to pre-doctor state
      try { await runners.buildRegistry(); } catch { /* best-effort */ }
      try { await runners.copyAssets(); } catch { /* best-effort */ }
    }

    // Only reaches here if no throw inside the try above.
    // NOTE: doctor() intentionally does NOT clearLastError() on success (unlike
    // install()/uninstall()) — it's a dry-run that installs nothing, so it must
    // not erase a real prior install failure's post-mortem record. Leave as-is.
    return {ok: true, id, version: manifest.version, kind: manifest.kind};
  } catch (e) {
    _writeLastError({op: 'doctor', id, stage: e.stage ?? 'doctor', message: e.message});
    throw e;
  } finally {
    if (runDir) rmSync(runDir, {recursive: true, force: true});
    if (snap) {
      if (snap.snapshotDir) rmSync(snap.snapshotDir, {recursive: true, force: true});
      if (snap.snapshotAssetsDir) rmSync(snap.snapshotAssetsDir, {recursive: true, force: true});
      if (snap.snapshotPreviewsDir) rmSync(snap.snapshotPreviewsDir, {recursive: true, force: true});
    }
    _releaseLock();
  }
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

// Guard: only run when this file is the entry-point (not when imported).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , cmd, ...args] = process.argv;

  const COMMANDS = ['install', 'uninstall', 'doctor', 'list', 'state', 'clear-last-error'];

  function printUsage() {
    process.stderr.write(
      'Usage: node scripts/install.mjs <command>\n\n' +
        'Commands:\n' +
        '  install <zip|dir> [--update] [--confirm-replace] [--override-capability] [--sha256 <hex>]\n' +
        '                    Install a template from a zip or directory source\n' +
        '  install --from-marketplace <id> [--update] [--confirm-replace]\n' +
        '                    Install a template from the local marketplace catalog\n' +
        '  uninstall <id>    Uninstall a template by id\n' +
        '  doctor <zip|dir>  Dry-run the full install gate without installing\n' +
        '  list              List installed templates\n' +
        '  state             Print full installer state as JSON\n' +
        '  clear-last-error  Remove the last-error record\n',
    );
  }

  if (!cmd || !COMMANDS.includes(cmd)) {
    printUsage();
    process.exit(1);
  }

  async function main() {
    if (cmd === 'install') {
      const update = args.includes('--update');
      const confirmReplace = args.includes('--confirm-replace');

      // --from-marketplace: positional is the package id, not a path
      if (args.includes('--from-marketplace')) {
        const fromMpIdx = args.indexOf('--from-marketplace');
        const id = args[fromMpIdx + 1];
        if (!id || id.startsWith('--')) {
          process.stderr.write('[install] error: --from-marketplace requires an <id> argument\n');
          printUsage();
          process.exit(1);
        }
        process.stderr.write(`[install] installing from marketplace: ${id} — the preview render stage can take a couple of minutes…\n`);
        const result = await installFromMarketplace(id, {update, confirmReplace});
        const kindStr = result.kind;
        const previewStr = result.preview;
        if (result.updated) {
          process.stderr.write(`[install] updated from v${result.updated.from}\n`);
        }
        console.log(`[install] installed ${result.id} v${result.version} (${kindStr}) — preview at ${previewStr}`);
        console.log('[install] on disk, not yet committed — commit templates/' + result.id + ' when ready.');
        return;
      }

      const src = args.find((a) => !a.startsWith('--'));
      if (!src) {
        process.stderr.write('[install] error: missing <zip|dir> argument\n');
        printUsage();
        process.exit(1);
      }
      const overrideCapability = args.includes('--override-capability');
      let sha256;
      const sha256Idx = args.indexOf('--sha256');
      if (sha256Idx !== -1) {
        sha256 = args[sha256Idx + 1];
        if (!sha256) {
          process.stderr.write('[install] error: --sha256 requires a hex argument\n');
          process.exit(1);
        }
      }

      // Print latency notice BEFORE calling install (the engine has no progress events)
      process.stderr.write(`[install] installing ${src} — the preview render stage can take a couple of minutes…\n`);

      const result = await install(src, {update, confirmReplace, overrideCapability, sha256});

      const kindStr = result.kind;
      const previewStr = result.preview;
      if (result.updated) {
        process.stderr.write(`[install] updated from v${result.updated.from}\n`);
      }
      console.log(`[install] installed ${result.id} v${result.version} (${kindStr}) — preview at ${previewStr}`);
      console.log('[install] on disk, not yet committed — commit templates/' + result.id + ' when ready.');

    } else if (cmd === 'uninstall') {
      const id = args[0];
      if (!id) {
        process.stderr.write('[uninstall] error: missing <id> argument\n');
        printUsage();
        process.exit(1);
      }

      // Pre-scan references BEFORE calling uninstall (which removes the template)
      const refs = scanReferences(id);

      // Print reference warning
      process.stderr.write(`[uninstall] "${id}" is referenced by ${refs.total} project spec(s):\n`);
      for (const f of refs.files) {
        process.stderr.write(`  ${f.path}\n`);
      }
      process.stderr.write('\n');

      // §17.2 consequence copy — VERBATIM
      process.stderr.write(
        'Scenes and overlays will show the loud MissingTemplate placeholder; transitions fall back to a silent hard cut. Editing, assembling, or re-rendering those projects will fail loudly until the template is reinstalled or the scenes are re-templated.\n',
      );

      const result = await uninstall(id);
      console.log(`[uninstall] removed ${result.id}`);

    } else if (cmd === 'doctor') {
      const src = args[0];
      if (!src) {
        process.stderr.write('[doctor] error: missing <zip|dir> argument\n');
        printUsage();
        process.exit(1);
      }

      process.stderr.write(
        `[doctor] checking ${src} — runs the full install gate (tsc + preview render, a couple of minutes) without installing…\n`,
      );

      const result = await doctor(src);
      console.log(`[doctor] OK: ${result.id} v${result.version} (${result.kind}) is installable`);

    } else if (cmd === 'list') {
      const installed = listInstalled();
      if (installed.length === 0) {
        console.log('(no templates installed)');
      } else {
        // Aligned table: id, version, kind, author
        const colWidths = {
          id: Math.max(2, ...installed.map((t) => t.id.length)),
          version: Math.max(7, ...installed.map((t) => t.version.length)),
          kind: Math.max(4, ...installed.map((t) => t.kind.length)),
          author: Math.max(6, ...installed.map((t) => t.author.length)),
        };
        const pad = (s, n) => s.padEnd(n);
        const header =
          `  ${pad('ID', colWidths.id)}  ${pad('VERSION', colWidths.version)}  ${pad('KIND', colWidths.kind)}  ${pad('AUTHOR', colWidths.author)}`;
        const sep = '  ' + '-'.repeat(header.length - 2);
        console.log(header);
        console.log(sep);
        for (const t of installed) {
          console.log(
            `  ${pad(t.id, colWidths.id)}  ${pad(t.version, colWidths.version)}  ${pad(t.kind, colWidths.kind)}  ${pad(t.author, colWidths.author)}`,
          );
        }
      }
    } else if (cmd === 'state') {
      console.log(JSON.stringify(installedState(), null, 2));
    } else if (cmd === 'clear-last-error') {
      clearLastError();
      console.log('Last-error record cleared.');
    }
  }

  // Top-level dispatch: catch InstallError (and unexpected errors) → print FAILED + exit 1
  main().catch((e) => {
    const stage = e.stage ?? cmd;
    const cmdLabel = cmd === 'install' ? 'install'
      : cmd === 'uninstall' ? 'uninstall'
      : cmd === 'doctor' ? 'doctor'
      : cmd;
    process.stderr.write(`[${cmdLabel}] FAILED at ${stage}: ${e.message}\n`);
    process.exit(1);
  });
}
