// install-stages.mjs — Pure validation stages for the M2 installer pipeline.
//
// Extracted from install.mjs (Fix 2) to keep that file navigable as Task 10
// adds typecheck → register → preview → rollback.
//
// Exports:
//   SUPPORTED_API_VERSION  — re-exported for test-suite compat
//   _isValidId             — single id-format checker
//   _stageUnpack           — stage 1
//   _stageEnvelope         — stage 2
//   _stageContract         — contract (imperative pass)
//   _stageId               — stage 3
//   _stageCompat           — stage 4
//   _stageSchema           — stage 5
//   _runValidation         — pipeline driver (stages 1→5)
//
// install.mjs re-exports all of these so existing `import from './install.mjs'`
// callers continue to work without change.

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
import {resolve, join, dirname, basename, sep} from 'node:path';
import {createRequire} from 'node:module';
import {isDeepStrictEqual} from 'node:util';

import {
  TEMPLATES_DIR,
  STAGING_DIR,
  InstallError,
} from './install-paths.mjs';

// Shared default runner for gen-manifests — defined ONCE in install-runners.mjs
// (I-2) so this stage's fallback and install.mjs's _defaultRunners.genManifests
// are the SAME function object (no byte-duplication, no lockstep-comment drift).
import {genManifestsRunner} from './install-runners.mjs';

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Supported API version (§4.2 / §15.2)
// ---------------------------------------------------------------------------

/** The single apiVersion value this engine understands. */
export const SUPPORTED_API_VERSION = '1';

// ---------------------------------------------------------------------------
// Shared id-format helpers (used by _stageUnpack dir-branch AND _stageId)
// ---------------------------------------------------------------------------

/**
 * Return true if `id` is a valid template id:
 *   - matches ^[a-z][a-z0-9-]{1,40}$
 *   - is not 'scripts' or 'node_modules'
 *   - does not start with '.'
 *
 * This is the single source of truth for id validation — reused in
 * _stageUnpack (before any copy) and _stageId (after unpack).
 *
 * @param {string} id
 * @returns {boolean}
 */
export function _isValidId(id) {
  if (typeof id !== 'string') return false;
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) return false;
  if (id === 'scripts' || id === 'node_modules') return false;
  if (id.startsWith('.')) return false;
  return true;
}

/**
 * Throw InstallError('unpack', ...) if `id` is not a valid template id.
 * Used in the directory-source branch of _stageUnpack before any write.
 *
 * @param {string|undefined} id
 */
function _assertValidIdForUnpack(id) {
  if (!_isValidId(id)) {
    throw new InstallError(
      'unpack',
      `package manifest.id ${JSON.stringify(id)} is not a valid template id — refusing to stage`,
    );
  }
}

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
 * runDir/<manifest.id> (after validating the id is safe).
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

    // Belt: validate manifest.id BEFORE using it as a path component.
    // A malicious id like "../../zzz-victim" would escape the staging dir.
    // _isValidId is the single definition shared with _stageId (stage 3).
    _assertValidIdForUnpack(srcManifest.id);

    const destName = srcManifest.id;
    const dest = join(runDir, destName);

    // Suspenders: containment guard — same pattern used in the zip branch.
    const resolvedRunDir = resolve(runDir);
    if (!resolve(dest).startsWith(resolvedRunDir + sep)) {
      throw new InstallError('unpack', `directory source manifest.id "${srcManifest.id}" escapes staging dir — refusing to stage`);
    }

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
 * Discover all properly-installed templates (needed for consumes-uniqueness check).
 * Inline copy of _discoverInstalled from install.mjs — kept local to avoid
 * importing back into install.mjs (which would be circular).
 *
 * @returns {Array<{id: string, folder: string}>}
 */
function _discoverInstalledLocal() {
  const found = [];
  for (const entry of readdirSync(TEMPLATES_DIR, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'scripts' || entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue;
    const dir = join(TEMPLATES_DIR, entry.name);
    if (existsSync(join(dir, '.installing'))) continue;
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    found.push({id: manifest.id ?? entry.name, folder: entry.name});
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

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

  // (b)+(c) id format + reserved-name check.
  // _isValidId is the single source of truth (also guards _stageUnpack dir-branch).
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
    throw new InstallError('id', `manifest id "${id}" is invalid — must match ^[a-z][a-z0-9-]{1,40}$`);
  }
  if (id === 'scripts' || id === 'node_modules' || id.startsWith('.')) {
    throw new InstallError('id', `"${id}" is reserved and cannot be used as a template id`);
  }
  // Invariant: _isValidId(id) === true at this point.

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
    const others = _discoverInstalledLocal().filter((t) => t.id !== id);
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

// Default runner for gen-manifests in stage 5 — the SAME genManifestsRunner
// object install.mjs's _defaultRunners.genManifests points at (I-2: one source).
const _defaultRunners = {
  genManifests: genManifestsRunner,
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
export async function _stageSchema(tplDir, manifest, runDir, runners) {
  const effectiveRunners = {..._defaultRunners, ...runners};
  const hasSchemaFile = existsSync(join(tplDir, 'schema.ts')) || existsSync(join(tplDir, 'schema.js'));

  let liveManifest = manifest;

  if (hasSchemaFile) {
    // Save a deep copy of what was shipped
    const shippedInputSchema = JSON.parse(JSON.stringify(manifest.inputSchema));

    // Regenerate inputSchema by running gen-manifests against runDir
    // (runDir is the scan root — its only child is the template dir).
    // MUST await: genManifests is now async (I-1); the re-read below depends on
    // gen-manifests having finished writing manifest.json. A bare call would
    // race the re-read against the still-pending write.
    try {
      await effectiveRunners.genManifests(runDir);
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
    await _stageSchema(tplDir, manifest, runDir, opts.runners ?? {});

    return {runDir, tplDir, manifest, existing};
  } catch (err) {
    // On any failure: clean up the run dir, rethrow
    rmSync(runDir, {recursive: true, force: true});
    throw err;
  }
}
