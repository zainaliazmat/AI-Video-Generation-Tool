#!/usr/bin/env node
/**
 * build-marketplace-index.mjs
 *
 * Walks marketplace/packages/<id>/<version>/<id>/ (source folders),
 * builds a DETERMINISTIC zip per package (fixed mtime, sorted entries),
 * sha256s the zip bytes, and writes marketplace/index.json.
 *
 * Determinism approach: adm-zip with fixed mtime.
 *   After zip.addFile(name, buf), get the entry and set:
 *     entry.header.time = FIXED_MTIME
 *   This calls entry.header's `time` setter → Utils.fromDate2DOS(FIXED_MTIME)
 *   and stores the result as a uint32. Two builds on the same machine produce
 *   the same DOS-encoded timestamp → byte-identical zip → identical sha256.
 *   Entries are added in sorted relPath order. adm-zip uses no extra fields
 *   when creating entries programmatically (Buffer.alloc(0) default).
 *
 * Empty-store path: no packages dir / no packages → writes {catalogVersion:1, packages:[]}.
 * No timestamp in index.json (would churn and break determinism gate).
 */

import AdmZip from 'adm-zip';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(TEMPLATES_DIR, '..');
const MARKETPLACE_DIR = join(REPO_ROOT, 'marketplace');
const PACKAGES_DIR = join(MARKETPLACE_DIR, 'packages');

/** Fixed mtime stamped into every zip entry — determinism anchor. */
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

/**
 * Walk a directory recursively and return sorted relative paths (files only).
 * @param {string} baseDir  - the root of the walk
 * @param {string} prefix   - relative prefix accumulated during recursion
 * @returns {Array<{relPath:string, absPath:string}>}
 */
function walkDir(baseDir, prefix = '') {
  const entries = readdirSync(baseDir).sort(); // sort for determinism
  const results = [];
  for (const name of entries) {
    const abs = join(baseDir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      results.push(...walkDir(abs, rel));
    } else {
      results.push({relPath: rel, absPath: abs});
    }
  }
  return results;
}

/**
 * Build a deterministic zip from sourceDir.
 * All entries are prefixed with <id>/ so the zip unpacks to a valid templates/<id>/ folder.
 * @param {string} id         - package id (zip top-level folder name)
 * @param {string} sourceDir  - the inner <id>/ folder with manifest.json + component
 * @returns {Buffer} raw zip bytes
 */
function buildDeterministicZip(id, sourceDir) {
  const zip = new AdmZip();
  const files = walkDir(sourceDir); // already sorted

  for (const {relPath, absPath} of files) {
    const entryName = `${id}/${relPath}`;
    const content = readFileSync(absPath);
    zip.addFile(entryName, content, '', 0o644);
    // Force fixed mtime on the entry to achieve byte-identical output across builds.
    const entry = zip.getEntry(entryName);
    entry.header.time = FIXED_MTIME;
  }

  return zip.toBuffer();
}

/**
 * Scan marketplace/packages/ for all versioned packages and build the index.
 */
function buildIndex() {
  const packages = [];

  if (!existsSync(PACKAGES_DIR)) {
    // Empty store — write minimal index and exit.
    writeFileSync(
      join(MARKETPLACE_DIR, 'index.json'),
      JSON.stringify({catalogVersion: 1, packages: []}, null, 2) + '\n',
    );
    return;
  }

  const ids = readdirSync(PACKAGES_DIR).sort();
  for (const id of ids) {
    // Skip .gitkeep and other non-directory entries
    const idPath = join(PACKAGES_DIR, id);
    if (!statSync(idPath).isDirectory()) continue;

    const versions = readdirSync(idPath).sort();
    for (const version of versions) {
      const versionPath = join(idPath, version);
      if (!statSync(versionPath).isDirectory()) continue;

      // Source folder: marketplace/packages/<id>/<version>/<id>/
      const sourceDir = join(versionPath, id);
      if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) continue;

      // Read manifest from source
      const manifestPath = join(sourceDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

      // Build the zip
      const zipBuf = buildDeterministicZip(id, sourceDir);
      const zipFileName = `${id}-${version}.zip`;
      const zipRelPath = `packages/${id}/${version}/${zipFileName}`;
      const zipAbsPath = join(MARKETPLACE_DIR, zipRelPath);
      writeFileSync(zipAbsPath, zipBuf);

      // Compute sha256 of the zip bytes
      const sha256 = createHash('sha256').update(zipBuf).digest('hex');

      // Build the index entry (only fields from manifest that belong in the index)
      const entry = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version ?? version,
        kind: manifest.kind,
        apiVersion: manifest.apiVersion,
        author: manifest.author,
        ...(manifest.license ? {license: manifest.license} : {}),
        ...(manifest.description ? {description: manifest.description} : {}),
        ...(manifest.tags?.length ? {tags: manifest.tags} : {}),
        package: zipRelPath,
        sha256,
      };

      // Include preview.poster only when poster.jpg exists beside the source folder
      const posterPath = join(versionPath, 'poster.jpg');
      if (existsSync(posterPath)) {
        entry.preview = {poster: `packages/${id}/${version}/poster.jpg`};
      }

      packages.push(entry);
    }
  }

  // Sort by id for deterministic output
  packages.sort((a, b) => a.id.localeCompare(b.id));

  // Write index — no timestamp (determinism gate)
  const index = {catalogVersion: 1, packages};
  writeFileSync(
    join(MARKETPLACE_DIR, 'index.json'),
    JSON.stringify(index, null, 2) + '\n',
  );
}

// Ensure marketplace/ directory exists
mkdirSync(MARKETPLACE_DIR, {recursive: true});

buildIndex();
