import {spawn} from 'node:child_process';

// Mirror the renderer's freshly-produced assets into preview/public/ so the live
// @remotion/player (which serves from THIS app's public/, not remotion/public/)
// can fetch them. Runs `npm run copy-assets` (scripts/copy-assets.mjs).
//
// WHY this exists as a shared helper:
//   The per-gate routes (voice/timing/assemble/edit/generate) each inlined this
//   and call it after an op that touches spec.json or adds an asset. But the two
//   asset-PRODUCING SSE routes — /api/session/start (auto-run builds the whole
//   pipeline) and /api/session/[id]/approve (voice→scenes synthesizes the
//   voiceover + fetches all footage) — did NOT, so a freshly built session's
//   voiceover/footage stayed in remotion/public/assets and the player 404'd on
//   the always-on root <Audio>, buffering forever (the "stuck loading" bug).
//   Both now await this on success before emitting their `done` event.
//
// Never rejects: copy-assets is best-effort mirroring; a failure resolves so the
// SSE stream still closes cleanly (the player degrades to a 404, not a hang of
// the request). cwd is process.cwd() (the dev server runs in preview/, where the
// `copy-assets` npm script is defined).
export function copyAssets(): Promise<void> {
  return new Promise<void>((resolve) => {
    const cp = spawn('npm', ['run', 'copy-assets'], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });
    cp.on('error', () => resolve());
    cp.on('close', () => resolve());
  });
}
