/**
 * Tests for lib/copyAssets.ts + a wiring guard for the "stuck loading" bug.
 *
 * The bug: /api/session/start (auto-run) and /api/session/[id]/approve
 * (voice→scenes) produce the voiceover + footage in remotion/public/assets but
 * never mirrored them into preview/public/, so the live @remotion/player 404'd
 * on the always-on root <Audio> and buffered forever. Both routes must mirror
 * on success; these tests lock the helper's contract and guard the wiring.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const {spawnMock} = vi.hoisted(() => ({spawnMock: vi.fn()}));
vi.mock('node:child_process', () => ({spawn: spawnMock}));

import {copyAssets} from './copyAssets';

/** A fake ChildProcess whose 'close'/'error' handlers the test can fire on demand. */
function fakeChild() {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      handlers[event] = cb;
      return this;
    },
    fire(event: string, arg?: unknown) {
      handlers[event]?.(arg);
    },
  };
}

describe('copyAssets helper', () => {
  beforeEach(() => spawnMock.mockReset());

  it('runs `npm run copy-assets` without a shell and resolves on close', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const done = copyAssets();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual(['run', 'copy-assets']);
    expect(opts).toMatchObject({shell: false});

    child.fire('close', 0);
    await expect(done).resolves.toBeUndefined();
  });

  it('still resolves (never rejects) when the spawn errors — best-effort mirror', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const done = copyAssets();
    child.fire('error', new Error('npm not found'));
    await expect(done).resolves.toBeUndefined();
  });
});

describe('asset-mirror wiring (regression guard for the stuck-loading bug)', () => {
  it.each([['app/api/session/start/route.ts'], ['app/api/session/[id]/approve/route.ts']])(
    '%s imports and awaits copyAssets on the success path',
    (rel) => {
      const src = readFileSync(resolve(__dirname, '..', rel), 'utf8');
      expect(src).toMatch(/from ['"][^'"]*lib\/copyAssets['"]/);
      expect(src).toMatch(/await copyAssets\(\)/);
    },
  );
});
