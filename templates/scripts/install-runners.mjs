// install-runners.mjs — The single, shared definition of the installer's default
// heavy-stage runners (§15.2).
//
// Why this module exists (Fix I-2): the `genManifests` runner was previously
// defined byte-identically in BOTH install.mjs._defaultRunners and
// install-stages.mjs._defaultRunners, guarded only by a "keep in lockstep"
// comment — a real drift risk. Hoisting the one definition here means
// install-stages.mjs (stage 5 schema regen) and install.mjs (the full pipeline)
// reference the SAME genManifests function object.
//
// Why async (Fix I-1): the install/uninstall/doctor pipeline is async and
// awaits every runner. The previous runners used synchronous execFileSync,
// which BLOCKS the Node event loop for the entire multi-minute install. M4 will
// call install() inside a Next.js SSE route (§16.15-1 keep-alive-on-disconnect):
// a blocked loop can't emit keep-alive frames, can't observe a client
// disconnect, and freezes the whole server. The sync render also starved the
// vitest worker heartbeat ("Timeout calling onTaskUpdate"). Promisified
// execFile keeps the loop free; output is captured by default (no `stdio:'pipe'`
// needed — execFile returns {stdout, stderr} and rejects with .stdout/.stderr
// on non-zero exit).
//
// This module imports ONLY path constants from install-paths.mjs (which has no
// child_process / runner deps), so there is no import cycle.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

import {
  TEMPLATES_DIR,
  SCRIPTS_DIR,
  REPO_ROOT,
  REMOTION_DIR,
} from './install-paths.mjs';

const execFileP = promisify(execFile);

/**
 * Default runner for gen-manifests (stage 5 schema regen).
 *
 * Hoisted so install.mjs's defaultRunners.genManifests and
 * install-stages.mjs's _stageSchema default reference the SAME function object.
 *
 * @param {string} scanDir  Scan root passed to gen-manifests.ts --dir.
 */
export const genManifestsRunner = async (scanDir) => {
  await execFileP(
    join(TEMPLATES_DIR, 'node_modules', '.bin', 'tsx'),
    [join(SCRIPTS_DIR, 'gen-manifests.ts'), '--dir', scanDir],
  );
};

/**
 * Default runner implementations for the heavy pipeline stages.
 *
 * Replaceable per-call via opts.runners so the test suite can stub heavy stages
 * (tsc / preview / copyAssets) while still running the REAL buildRegistry so
 * registry assertions work.
 *
 * tsc runner note: `npx tsc --noEmit` in remotion/ uses remotion/tsconfig.json
 * which includes `../templates/**‌/*.tsx` via glob — so the freshly renamed
 * templates/<id> is typechecked by file glob even though it isn't in the
 * registry yet (tsc globs files, it doesn't need the registry).
 */
export const defaultRunners = {
  tsc: async () => {
    try {
      await execFileP('npx', ['tsc', '--noEmit'], {cwd: REMOTION_DIR});
    } catch (err) {
      // On a non-zero exit, execFileP REJECTS with an error carrying .stdout and
      // .stderr (strings, since execFile decodes by default). Preserve the same
      // ~30-line excerpt extraction the install() caller relies on — the e2e
      // tsc-error test asserts the surfaced InstallError message contains 'TS'.
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      const excerpt = out.split('\n').slice(0, 30).join('\n');
      throw Object.assign(new Error(excerpt || err.message), {_tscOriginal: true});
    }
  },
  buildRegistry: async () => {
    await execFileP('node', [join(SCRIPTS_DIR, 'build-registry.mjs')]);
  },
  // genManifests is used by _stageSchema (stage 5) via _runValidation's runners.
  // Same function object as the one install-stages.mjs imports — no drift.
  genManifests: genManifestsRunner,
  genPreviews: async (id) => {
    await execFileP('node', [
      join(REPO_ROOT, 'remotion', 'scripts', 'gen-previews.mjs'),
      '--only', id, '--force',
    ]);
  },
  copyAssets: async () => {
    await execFileP('node', [join(REPO_ROOT, 'preview', 'scripts', 'copy-assets.mjs')]);
  },
};
