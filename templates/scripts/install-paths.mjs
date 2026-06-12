// Shared path constants and InstallError — imported by both install.mjs and
// install-stages.mjs to avoid a circular dependency.
//
// No logic lives here — only filesystem constants and the error class.

import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

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
