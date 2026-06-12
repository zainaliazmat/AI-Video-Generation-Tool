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
  statSync,
  cpSync,
} from 'node:fs';
import {dirname, resolve, join, relative, basename, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';

const _require = createRequire(import.meta.url);

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
// Supported API version (§4.2 / §15.2)
// ---------------------------------------------------------------------------

/** The single apiVersion value this engine understands. */
export const SUPPORTED_API_VERSION = '1';

// ---------------------------------------------------------------------------
// Ajv validators — lazily compiled module-level singletons (§15.13)
// ---------------------------------------------------------------------------

// Ajv2020 is needed for the manifest envelope schema which self-declares
// `"$schema": "https://json-schema.org/draft/2020-12/schema"`.  Default Ajv
// silently mishandles that dialect (§4.2 foot-gun).
let _ajv2020Validator = null;

/**
 * Return (creating once) the compiled Ajv2020 validate() function for the
 * manifest envelope schema.
 */
function _getEnvelopeValidator() {
  if (_ajv2020Validator) return _ajv2020Validator;
  const {Ajv2020} = _require(join(TEMPLATES_DIR, 'node_modules', 'ajv', 'dist', '2020.js'));
  const ajv = new Ajv2020({strict: false, allErrors: true});
  const schema = JSON.parse(readFileSync(join(TEMPLATES_DIR, 'manifest.schema.json'), 'utf8'));
  _ajv2020Validator = ajv.compile(schema);
  return _ajv2020Validator;
}

// ---------------------------------------------------------------------------
// Stage 1 — unpack (§15.2)
// ---------------------------------------------------------------------------

/**
 * Unpack a zip or directory source into runDir.
 *
 * For a directory source: must contain manifest.json; copied recursively into
 * runDir/<basename>.
 *
 * For a zip: validates zip-bomb, zip-slip, and structural constraints before
 * extracting entry-by-entry.
 *
 * @param {string} src  Path to a zip file or a template directory.
 * @param {string} runDir  Temporary staging run directory.
 * @returns {string} tplDir — path to the unpacked template root inside runDir.
 */
export function _stageUnpack(src, runDir) {
  const st = statSync(src);

  if (st.isDirectory()) {
    // Directory source: must contain manifest.json.
    // Copy into runDir/<manifest.id> so that Stage 3's folder-name == id check
    // passes when the source dir name differs from the template id (common in
    // dev fixtures and tmp dirs).
    const manifestPath = join(src, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new InstallError('unpack', `directory source must contain manifest.json: ${src}`);
    }
    let srcManifest;
    try {
      srcManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      throw new InstallError('unpack', `cannot parse directory source manifest.json: ${e.message}`);
    }
    // Use manifest.id as the destination folder name so Stage 3 sees a match.
    // Fall back to basename if id is not yet readable (Stage 2 will reject later).
    const destName = srcManifest.id ?? basename(src);
    const dest = join(runDir, destName);
    cpSync(src, dest, {recursive: true});
    return dest;
  }

  // --- ZIP source ---

  // Compressed size cap: 50 MB (§15.2)
  const compressedSize = st.size;
  if (compressedSize > 50 * 1024 * 1024) {
    throw new InstallError('unpack', `zip is too large (${compressedSize} bytes, limit 50 MB)`);
  }

  // Open zip (any throw → not a valid zip)
  let AdmZip;
  try {
    AdmZip = _require(join(TEMPLATES_DIR, 'node_modules', 'adm-zip', 'adm-zip.js'));
  } catch (e) {
    throw new InstallError('unpack', `adm-zip unavailable: ${e.message}`);
  }
  let zip;
  try {
    zip = new AdmZip(src);
  } catch (e) {
    throw new InstallError('unpack', `not a valid zip: ${e.message}`);
  }

  const entries = zip.getEntries();

  // Entry count cap: ≤ 2000
  if (entries.length > 2000) {
    throw new InstallError('unpack', `zip has too many entries (${entries.length}; limit 2000 entries)`);
  }

  // Decompressed total size cap: ≤ 200 MB
  let totalDecompressed = 0;
  for (const entry of entries) {
    totalDecompressed += entry.header.size;
  }
  if (totalDecompressed > 200 * 1024 * 1024) {
    throw new InstallError(
      'unpack',
      `decompressed size exceeds 200 MB (${totalDecompressed} bytes)`,
    );
  }

  // Path safety: every entryName must pass our allowlist
  for (const entry of entries) {
    const name = entry.entryName;
    // Reject absolute paths (leading /)
    if (name.startsWith('/')) {
      throw new InstallError('unpack', `unsafe zip entry with absolute path: ${name}`);
    }
    // Reject backslashes (Windows path traversal)
    if (name.includes('\\')) {
      throw new InstallError('unpack', `unsafe zip entry with backslash: ${name}`);
    }
    // Reject drive-letter patterns (e.g. C:)
    if (/^[a-zA-Z]:/.test(name)) {
      throw new InstallError('unpack', `unsafe zip entry with drive letter: ${name}`);
    }
    // Reject .. segments anywhere in path
    const segments = name.split('/');
    if (segments.some((s) => s === '..')) {
      throw new InstallError('unpack', `unsafe zip entry contains .. path segment: ${name}`);
    }
  }

  // All entries must share EXACTLY one top-level folder segment
  const topSegments = new Set();
  for (const entry of entries) {
    const parts = entry.entryName.split('/');
    topSegments.add(parts[0]);
  }
  if (topSegments.size !== 1) {
    throw new InstallError(
      'unpack',
      `zip must have exactly one top-level folder (found: ${[...topSegments].join(', ')})`,
    );
  }
  const [topSegment] = topSegments;

  // Extract entry-by-entry (defense-in-depth: re-check resolved paths)
  const resolvedRunDir = resolve(runDir);
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const dest = join(runDir, entry.entryName);
    const resolvedDest = resolve(dest);
    // Defense in depth: resolved dest must be inside runDir
    if (!resolvedDest.startsWith(resolvedRunDir + sep)) {
      throw new InstallError('unpack', `zip entry escapes run dir: ${entry.entryName}`);
    }
    mkdirSync(dirname(dest), {recursive: true});
    writeFileSync(dest, entry.getData());
  }

  return join(runDir, topSegment);
}

// ---------------------------------------------------------------------------
// Stage 2 — envelope (§4.2 / §15.2)
// ---------------------------------------------------------------------------

/**
 * Validate tplDir/manifest.json against the manifest schema (Ajv2020).
 *
 * On schema failure the error message names the offending field using
 * instancePath + params.missingProperty / params.additionalProperty so the
 * operator knows exactly what to fix.
 *
 * @param {string} tplDir
 * @returns {object} Parsed manifest object.
 */
export function _stageEnvelope(tplDir) {
  const manifestPath = join(tplDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new InstallError('envelope', `cannot read/parse manifest.json: ${e.message}`);
  }

  const validate = _getEnvelopeValidator();
  if (!validate(manifest)) {
    // Build a precise error message naming the offending field(s)
    const messages = (validate.errors ?? []).map((err) => {
      if (err.keyword === 'required') {
        const field = err.params?.missingProperty ?? '?';
        return `missing required field "${field}"`;
      }
      if (err.keyword === 'additionalProperties') {
        const field = err.params?.additionalProperty ?? '?';
        return `unknown field "${field}"`;
      }
      // enum, type, etc. — use instancePath
      const path = err.instancePath || '(root)';
      return `${path}: ${err.message}`;
    });
    throw new InstallError('envelope', `manifest.json failed schema validation: ${messages.join('; ')}`);
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Imperative pass — contract (§15.13 / §4.4)
// ---------------------------------------------------------------------------

/**
 * Enforce asset and license contracts on a validated manifest.
 *
 * (a) Non-core authors must supply a license.
 * (b) If assets/ contains non-CREDITS.json files, CREDITS.json must exist.
 * (c) Every assets/ file except CREDITS.json must be declared in manifest.assets.
 * (d) Every declared path must start with 'assets/', contain no '..', and exist.
 * (e) Declared non-empty assets but no assets/ dir → rejected via (d).
 *
 * @param {string} tplDir
 * @param {object} manifest
 */
export function _stageContract(tplDir, manifest) {
  // (a) License required for non-core authors
  if (manifest.author !== 'core' && !manifest.license) {
    throw new InstallError(
      'contract',
      `manifest "license" is required for non-core authors (author="${manifest.author}") — add an SPDX license identifier`,
    );
  }

  // Collect actual files in assets/ (if the dir exists)
  const assetsDir = join(tplDir, 'assets');
  let actualFiles = []; // relative paths like "assets/foo.png"
  if (existsSync(assetsDir)) {
    const walkDir = (dir, relBase) => {
      for (const e of readdirSync(dir, {withFileTypes: true})) {
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walkDir(join(dir, e.name), rel);
        } else {
          actualFiles.push(`assets/${rel}`);
        }
      }
    };
    walkDir(assetsDir, '');
  }

  const nonCreditsFiles = actualFiles.filter((f) => f !== 'assets/CREDITS.json');

  // (b) CREDITS.json required when any non-CREDITS asset ships
  if (nonCreditsFiles.length > 0 && !actualFiles.includes('assets/CREDITS.json')) {
    throw new InstallError(
      'contract',
      `assets/CREDITS.json is required when assets ship (§4.4) — add a CREDITS.json listing rights`,
    );
  }

  const declaredAssets = manifest.assets ?? [];

  // (c) Every non-CREDITS file must be declared
  for (const rel of nonCreditsFiles) {
    if (!declaredAssets.includes(rel)) {
      throw new InstallError(
        'contract',
        `undeclared file in assets/: "${rel}" — add it to manifest.assets or remove it`,
      );
    }
  }

  // (d) Every declared path must: start with 'assets/', contain no '..', and exist
  for (const declared of declaredAssets) {
    if (!declared.startsWith('assets/')) {
      throw new InstallError('contract', `declared asset path must start with "assets/": "${declared}"`);
    }
    if (declared.includes('..')) {
      throw new InstallError('contract', `declared asset path contains "..": "${declared}"`);
    }
    if (!existsSync(join(tplDir, declared))) {
      throw new InstallError('contract', `declared asset does not exist in package: "${declared}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — id (§15.3 / §15.8 / §16.4)
// ---------------------------------------------------------------------------

/**
 * Validate template id safety and handle install/update collision logic.
 *
 * Returns the existing manifest when updating (for the driver to snapshot),
 * or null for a fresh install.
 *
 * @param {object} manifest
 * @param {string} tplDir  Path to unpacked template root.
 * @param {{update?: boolean, confirmReplace?: boolean, overrideCapability?: boolean}} opts
 * @returns {object|null} existing manifest on update, null otherwise
 */
export function _stageId(manifest, tplDir, opts = {}) {
  const {id} = manifest;

  // (a) Top folder basename must match manifest.id
  if (basename(tplDir) !== id) {
    throw new InstallError(
      'id',
      `folder name "${basename(tplDir)}" does not match manifest id "${id}" — rename the top-level folder`,
    );
  }

  // (b) id must match ^[a-z][a-z0-9-]{1,40}$
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
    throw new InstallError('id', `manifest id "${id}" is invalid — must match ^[a-z][a-z0-9-]{1,40}$`);
  }

  // (c) Reserved names and leading-dot guard
  if (id === 'scripts' || id === 'node_modules' || id.startsWith('.')) {
    throw new InstallError('id', `"${id}" is reserved and cannot be used as a template id`);
  }

  // (d) Collision detection
  const installDir = join(TEMPLATES_DIR, id);
  const exists = existsSync(installDir);

  if (exists && !opts.update) {
    throw new InstallError(
      'id',
      `"${id}" is already installed (templates/${id} exists) — use --update to upgrade`,
    );
  }

  let existingManifest = null;

  if (exists && opts.update) {
    // Read the installed manifest — manifest-less dir collisions are rejected
    let installed;
    try {
      installed = JSON.parse(readFileSync(join(installDir, 'manifest.json'), 'utf8'));
    } catch {
      throw new InstallError(
        'id',
        `"${id}" exists on disk but has no readable manifest.json — cannot update; remove the directory manually`,
      );
    }

    // Refuse to overwrite core templates
    if (installed.author === 'core') {
      throw new InstallError('id', `"${id}" is a core template and cannot be replaced`);
    }

    // Semver ladder: strict x.y.z integer triples
    const parseSemver = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
      if (!m) return null;
      return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    };
    const incomingV = parseSemver(manifest.version);
    const existingV = parseSemver(installed.version);

    if (!incomingV) {
      throw new InstallError('id', `incoming version "${manifest.version}" is not semver (x.y.z)`);
    }
    if (!existingV) {
      throw new InstallError('id', `installed version "${installed.version}" is not semver (x.y.z)`);
    }

    // Compare: [major, minor, patch] lexicographically
    const cmp = (a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a[i] > b[i]) return 1;
        if (a[i] < b[i]) return -1;
      }
      return 0;
    };
    const rel = cmp(incomingV, existingV);

    if (rel < 0) {
      throw new InstallError(
        'id',
        `cannot downgrade "${id}" from ${installed.version} to ${manifest.version}`,
      );
    }
    if (rel === 0) {
      if (!opts.confirmReplace) {
        throw new InstallError(
          'id',
          `"${id}" at same version ${manifest.version} — use --confirm-replace to force reinstall`,
        );
      }
      // confirmReplace: allow equal-version reinstall
    }
    // rel > 0: upgrade — proceed

    existingManifest = installed;
  }

  // (e) Consumes-uniqueness (§15.8)
  if (manifest.consumes) {
    const cap = manifest.consumes;
    const others = _discoverInstalled().filter((t) => t.id !== id);
    for (const other of others) {
      // Read the full manifest of each installed template to check consumes
      let otherManifest;
      try {
        otherManifest = JSON.parse(readFileSync(join(TEMPLATES_DIR, other.folder, 'manifest.json'), 'utf8'));
      } catch {
        continue;
      }
      if (otherManifest.consumes === cap) {
        if (!opts.overrideCapability) {
          throw new InstallError(
            'id',
            `consumes "${cap}" is already provided by "${other.id}" — use --override-capability to force`,
          );
        }
        break; // overrideCapability: allow
      }
    }
  }

  return existingManifest;
}

// ---------------------------------------------------------------------------
// Stage 4 — compat (§4.2)
// ---------------------------------------------------------------------------

/**
 * Assert that the manifest's apiVersion is supported by this engine.
 *
 * @param {object} manifest
 */
export function _stageCompat(manifest) {
  if (manifest.apiVersion !== SUPPORTED_API_VERSION) {
    throw new InstallError(
      'compat',
      `apiVersion "${manifest.apiVersion}" is not supported by this engine (expected "${SUPPORTED_API_VERSION}")`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — schema (§6.5 / §15.13)
// ---------------------------------------------------------------------------

/** Default runner for gen-manifests in stage 5. */
const _defaultRunners = {
  genManifests: (scanDir) =>
    execFileSync(
      join(TEMPLATES_DIR, 'node_modules', '.bin', 'tsx'),
      [join(SCRIPTS_DIR, 'gen-manifests.ts'), '--dir', scanDir],
      {stdio: 'pipe'},
    ),
};

/**
 * Validate shipped inputSchema (via regen diff) and sampleProps.
 *
 * If the template has schema.ts or schema.js:
 *   1. Deep-copy the shipped inputSchema.
 *   2. Run runners.genManifests(runDir) to regenerate from the staged zod schema.
 *   3. Re-read tplDir/manifest.json and compare regenerated vs shipped.
 *      Mismatch → InstallError('schema', '… stale …').
 *
 * Always (schema.ts or not):
 *   4. Validate manifest.sampleProps against manifest.inputSchema with draft-07 Ajv.
 *
 * @param {string} tplDir
 * @param {object} manifest  Live manifest object (may be mutated by regen; use re-read value).
 * @param {string} runDir
 * @param {object} runners
 */
export function _stageSchema(tplDir, manifest, runDir, runners) {
  const effectiveRunners = {..._defaultRunners, ...runners};
  const hasSchemaFile = existsSync(join(tplDir, 'schema.ts')) || existsSync(join(tplDir, 'schema.js'));

  let liveManifest = manifest;

  if (hasSchemaFile) {
    // Save a deep copy of what was shipped
    const shippedInputSchema = JSON.parse(JSON.stringify(manifest.inputSchema));

    // Regenerate inputSchema by running gen-manifests against runDir
    // (runDir is the scan root — its only child is the template dir)
    try {
      effectiveRunners.genManifests(runDir);
    } catch (e) {
      throw new InstallError('schema', `gen-manifests failed during schema regen: ${e.message}`);
    }

    // Re-read the manifest (gen-manifests overwrites it in place)
    try {
      liveManifest = JSON.parse(readFileSync(join(tplDir, 'manifest.json'), 'utf8'));
    } catch (e) {
      throw new InstallError('schema', `cannot re-read manifest.json after regen: ${e.message}`);
    }

    // Compare regenerated inputSchema to shipped
    if (!isDeepStrictEqual(liveManifest.inputSchema, shippedInputSchema)) {
      throw new InstallError(
        'schema',
        `shipped inputSchema is stale — re-run gen-manifests before packaging (run: npm run gen-manifests in templates/)`,
      );
    }
  }

  // Always: validate sampleProps against inputSchema (draft-07 Ajv, strict:false)
  const AjvModule = _require(join(TEMPLATES_DIR, 'node_modules', 'ajv', 'dist', 'ajv.js'));
  const Ajv = AjvModule.default ?? AjvModule;
  const ajv = new Ajv({strict: false, allErrors: true});
  const validate = ajv.compile(liveManifest.inputSchema);
  if (!validate(liveManifest.sampleProps)) {
    const messages = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw new InstallError('schema', `sampleProps do not satisfy inputSchema: ${messages}`);
  }
}

// ---------------------------------------------------------------------------
// _runValidation driver (§15.2)
// ---------------------------------------------------------------------------

let _runCounter = 0;

/**
 * Run the full validation pipeline (stages 1→2→contract→3→4→5) in a fresh
 * staging run directory.
 *
 * Does NOT take the lock — the install()/doctor() drivers own locking.
 *
 * On any failure: removes the run dir, then rethrows the InstallError.
 *
 * @param {string} srcZipOrDir  Path to a zip or template directory.
 * @param {{update?: boolean, confirmReplace?: boolean, overrideCapability?: boolean, runners?: object}} opts
 * @returns {Promise<{runDir: string, tplDir: string, manifest: object, existing: object|null}>}
 */
export async function _runValidation(srcZipOrDir, opts = {}) {
  mkdirSync(STAGING_DIR, {recursive: true});
  const runId = `run-${process.pid}-${_runCounter++}`;
  const runDir = join(STAGING_DIR, runId);
  mkdirSync(runDir, {recursive: true});

  try {
    // Stage 1: unpack
    const tplDir = _stageUnpack(srcZipOrDir, runDir);

    // Stage 2: envelope
    const manifest = _stageEnvelope(tplDir);

    // Imperative pass: contract (§15.13)
    _stageContract(tplDir, manifest);

    // Stage 3: id
    const existing = _stageId(manifest, tplDir, opts);

    // Stage 4: compat
    _stageCompat(manifest);

    // Stage 5: schema
    _stageSchema(tplDir, manifest, runDir, opts.runners ?? {});

    return {runDir, tplDir, manifest, existing};
  } catch (err) {
    // On any failure: clean up the run dir, rethrow
    rmSync(runDir, {recursive: true, force: true});
    throw err;
  }
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
