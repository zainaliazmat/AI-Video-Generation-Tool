// @vitest-environment jsdom
/**
 * Regression test for the Studio v3 "locking the script — the voice gate opens
 * next" hang (dev-only).
 *
 * Bug: GateInterstitial auto-runs its approve POST + SSE consumption inside a
 * useEffect. Under reactStrictMode (next dev), React double-invokes the effect:
 * setup → cleanup → setup. The original cleanup bumped `genRef`, invalidating
 * the only in-flight run (alive() → false), while the `startedRef` guard made
 * the second setup return early without starting a new run. The POST fired (the
 * backend approved — gates advanced in the DB) but the `done` SSE event was
 * dropped, so onDone never fired and the page hung forever.
 *
 * These tests render the REAL component under <StrictMode> in jsdom and assert:
 *   1. onDone fires exactly once after a `done` SSE frame (no hang).
 *   2. the POST thunk (`stream`) fires exactly once (no double-approve / 409).
 *
 * Per-file jsdom env override; the rest of the suite stays node-env.
 */
import {StrictMode, act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {GateInterstitial} from './GateInterstitial';
import type {GatesDict} from '../lib/studio';

// React's act() needs this flag set in test environments.
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const enc = new TextEncoder();

function sseResponse(frames: string[], status = 200): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.close();
    },
  });
  return new Response(stream, {status});
}

const DONE_GATES: GatesDict = {
  script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
  voice: {state: 'awaiting_approval', approved_at: null},
};
const DONE_FRAME = `data: ${JSON.stringify({type: 'done', gates: DONE_GATES})}\n\n`;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// A short async settle so the run()'s `await stream()` + readSse microtasks flush.
async function settle(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('GateInterstitial — StrictMode double-invoke (script→voice approve hang)', () => {
  it('fires onDone after a done frame even under StrictMode (no hang)', async () => {
    const onDone = vi.fn();
    const stream = vi.fn(() => Promise.resolve(sseResponse([DONE_FRAME])));

    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(GateInterstitial, {stream, onDone, tasks: [], sid: 's-strict'}),
        ),
      );
    });
    await settle();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(DONE_GATES, undefined);
  });

  it('fires the approve POST exactly once under StrictMode (no double-approve / 409)', async () => {
    const onDone = vi.fn();
    const stream = vi.fn(() => Promise.resolve(sseResponse([DONE_FRAME])));

    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(GateInterstitial, {stream, onDone, tasks: [], sid: 's-once'}),
        ),
      );
    });
    await settle();

    expect(stream).toHaveBeenCalledTimes(1);
  });
});
