// Template installer engine — §15.2 verify-before-register pipeline.
//
// This module is the authoritative home for the M2 installer's core machinery.
// Pipeline stages (unpack → envelope → contract → id → compat → schema →
// typecheck → register → preview) land here in later tasks; this skeleton
// establishes the foundation every stage depends on.
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
} from 'node:fs';
import {dirname, resolve, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/** templates/ directory — the installer's domain */
export const TEMPLATES_DIR = resolve(__dirname, '..');

/** templates/scripts/ directory */
export const SCRIPTS_DIR = __dirname;

/** templates/.staging/ — lock, last-error, run-dirs */
export const STAGING_DIR = join(TEMPLATES_DIR, '.staging');

/** templates/.staging/.lock */
export const LOCK_PATH = join(STAGING_DIR, '.lock');

/** templates/.staging/last-error.json */
export const LAST_ERROR_PATH = join(STAGING_DIR, 'last-error.json');

/** repo root (one level above templates/) */
export const REPO_ROOT = resolve(TEMPLATES_DIR, '..');

/** remotion/ directory */
export const REMOTION_DIR = resolve(REPO_ROOT, 'remotion');

/** remotion/public/template-assets/ */
export const RENDER_ASSETS_DIR = join(REMOTION_DIR, 'public', 'template-assets');

/** preview/public/previews/ */
export const PREVIEWS_DIR = resolve(REPO_ROOT, 'preview', 'public', 'previews');

// ---------------------------------------------------------------------------
// InstallError
// ---------------------------------------------------------------------------

/**
 * Typed error for installer pipeline failures.
 *
 * @property {string} stage  — pipeline stage where the failure occurred.
 *   One of: 'lock' | 'unpack' | 'envelope' | 'contract' | 'id' | 'compat' |
 *   'schema' | 'typecheck' | 'register' | 'preview' | 'integrity' | 'uninstall'
 * @property {number} statusCode — 409 for lock conflicts (already running),
 *   else 1.
 */
export class InstallError extends Error {
  constructor(stage, message, {statusCode = 1} = {}) {
    super(message);
    this.name = 'InstallError';
    this.stage = stage;
    this.statusCode = statusCode;
  }
}

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
        } catch {
          alive = false; // ESRCH — no such process
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

  if (liveLockPid !== null) return; // don't sweep while a live op is running

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
 * @returns {TemplateInfo[]} sorted by id
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
      const out = execFileSync(
        'git',
        ['status', '--porcelain', '--', `templates/${t.id}`],
        {cwd: REPO_ROOT, encoding: 'utf8'},
      );
      uncommitted = out.trim().length > 0;
    } catch {
      // git not available or not a git repo — treat as committed
      uncommitted = false;
    }
    return {...t, uncommitted};
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
// CLI shell
// ---------------------------------------------------------------------------

// Guard: only run when this file is the entry-point (not when imported).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , cmd, ...args] = process.argv;

  function printUsage() {
    process.stderr.write(
      'Usage: node scripts/install.mjs <command>\n\n' +
        'Commands:\n' +
        '  list              List installed templates\n' +
        '  state             Print full installer state as JSON\n' +
        '  clear-last-error  Remove the last-error record\n' +
        '\n(install/uninstall/doctor are wired in later tasks)\n',
    );
  }

  if (!cmd || !['list', 'state', 'clear-last-error'].includes(cmd)) {
    printUsage();
    process.exit(1);
  }

  if (cmd === 'list') {
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
