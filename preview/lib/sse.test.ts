/**
 * Tests for lib/sse.ts — readSse frame parser.
 *
 * We feed canned byte chunks through a mock ReadableStream<Uint8Array> and assert
 * the exact sequence of SseEvent objects dispatched to the onEvent callback.
 */
import {describe, it, expect, vi} from 'vitest';
import {readSse} from './sse';
import type {SseEvent} from './sse';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** Build a mock Response whose body is a ReadableStream that yields the given chunks. */
function mockResponse(chunks: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {status: 200});
}

/** Convenience: run readSse and collect all dispatched events. */
async function collect(chunks: string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  await readSse(mockResponse(chunks), (e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// 1) Canonical single-chunk stream
// ---------------------------------------------------------------------------
describe('readSse — basic dispatch', () => {
  it('dispatches a sid event', async () => {
    const events = await collect([
      'data: {"type":"sid","sid":"abc123"}\n\n',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'sid', sid: 'abc123'});
  });

  it('dispatches a stage running event', async () => {
    const events = await collect([
      'data: {"type":"stage","stage":"script","state":"running"}\n\n',
    ]);
    expect(events[0]).toEqual({type: 'stage', stage: 'script', state: 'running'});
  });

  it('dispatches a stage done event with elapsed_s', async () => {
    const events = await collect([
      'data: {"type":"stage","stage":"voice","state":"done","elapsed_s":4.2}\n\n',
    ]);
    expect(events[0]).toEqual({type: 'stage', stage: 'voice', state: 'done', elapsed_s: 4.2});
  });

  it('dispatches a stage failed event with error', async () => {
    const events = await collect([
      'data: {"type":"stage","stage":"scenes","state":"failed","error":"timeout"}\n\n',
    ]);
    expect(events[0]).toEqual({type: 'stage', stage: 'scenes', state: 'failed', error: 'timeout'});
  });

  it('dispatches a done event with sid + gates', async () => {
    const gates = {script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'}};
    const events = await collect([
      `data: ${JSON.stringify({type: 'done', sid: 'xyz', gates})}\n\n`,
    ]);
    expect(events[0]).toEqual({type: 'done', sid: 'xyz', gates});
  });

  it('dispatches a done event without sid/gates (bare done)', async () => {
    const events = await collect([
      'data: {"type":"done"}\n\n',
    ]);
    expect(events[0]).toEqual({type: 'done', sid: undefined, gates: undefined});
  });

  it('dispatches an error event (error field)', async () => {
    const events = await collect([
      'data: {"type":"error","error":"something broke"}\n\n',
    ]);
    expect(events[0]).toEqual({type: 'error', error: 'something broke', message: undefined});
  });

  it('dispatches an error event (message field — legacy render pattern)', async () => {
    const events = await collect([
      'data: {"type":"error","message":"render failed"}\n\n',
    ]);
    expect(events[0]).toEqual({type: 'error', error: undefined, message: 'render failed'});
  });
});

// ---------------------------------------------------------------------------
// 2) Multi-frame dispatch order
// ---------------------------------------------------------------------------
describe('readSse — multi-frame stream', () => {
  it('dispatches all frames in order from a single chunk', async () => {
    const events = await collect([
      'data: {"type":"sid","sid":"s1"}\n\n' +
      'data: {"type":"stage","stage":"script","state":"running"}\n\n' +
      'data: {"type":"stage","stage":"script","state":"done","elapsed_s":2.1}\n\n' +
      'data: {"type":"done","sid":"s1","gates":null}\n\n',
    ]);
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe('sid');
    expect(events[1]).toMatchObject({type: 'stage', state: 'running'});
    expect(events[2]).toMatchObject({type: 'stage', state: 'done', elapsed_s: 2.1});
    expect(events[3].type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 3) LOAD-BEARING: split frame across chunk boundaries
// ---------------------------------------------------------------------------
describe('readSse — split frame across chunks', () => {
  it('reassembles a frame split mid-payload across two chunks', async () => {
    // The `data:` line is split: first chunk ends in the middle of the JSON.
    const full = 'data: {"type":"stage","stage":"voice","state":"running"}\n\n';
    const split = 50; // arbitrary mid-point inside the JSON
    const chunk1 = full.slice(0, split);
    const chunk2 = full.slice(split);

    const events = await collect([chunk1, chunk2]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'stage', stage: 'voice', state: 'running'});
  });

  it('handles frame split at the \\n\\n boundary (only first \\n in chunk1)', async () => {
    const frame = 'data: {"type":"sid","sid":"split-test"}\n\n';
    // Put the first \n in chunk1, second \n in chunk2.
    const idx = frame.indexOf('\n\n');
    const chunk1 = frame.slice(0, idx + 1);   // up to and including first \n
    const chunk2 = frame.slice(idx + 1);      // second \n onward

    const events = await collect([chunk1, chunk2]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'sid', sid: 'split-test'});
  });

  it('handles three chunks that together form two frames', async () => {
    // Frame A split across chunks 1+2, frame B in chunk 3.
    const frameA = 'data: {"type":"sid","sid":"A"}\n\n';
    const frameB = 'data: {"type":"done","sid":"A"}\n\n';
    const splitAt = 20;
    const events = await collect([
      frameA.slice(0, splitAt),
      frameA.slice(splitAt) + frameB.slice(0, 15),
      frameB.slice(15),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({type: 'sid', sid: 'A'});
    expect(events[1]).toMatchObject({type: 'done', sid: 'A'});
  });
});

// ---------------------------------------------------------------------------
// 4) Full canned stream (the spec's representative multi-event example)
// ---------------------------------------------------------------------------
describe('readSse — full canned multi-event stream', () => {
  it('dispatches the exact event sequence from a representative stream', async () => {
    const gates = {
      script: {state: 'approved', approved_at: '2026-06-13T10:00:00Z'},
      voice: {state: 'awaiting_approval', approved_at: null},
    };
    // Deliver in 3 chunks to exercise buffering.
    const allFrames =
      'data: {"type":"sid","sid":"full-test"}\n\n' +
      'data: {"type":"stage","stage":"script","state":"running"}\n\n' +
      'data: {"type":"stage","stage":"script","state":"done","elapsed_s":3.5}\n\n' +
      'data: {"type":"stage","stage":"voice","state":"running"}\n\n' +
      'data: {"type":"stage","stage":"voice","state":"done","elapsed_s":12.0}\n\n' +
      `data: ${JSON.stringify({type: 'done', sid: 'full-test', gates})}\n\n`;

    const third = Math.floor(allFrames.length / 3);
    const events = await collect([
      allFrames.slice(0, third),
      allFrames.slice(third, 2 * third),
      allFrames.slice(2 * third),
    ]);

    expect(events).toHaveLength(6);
    expect(events[0]).toEqual({type: 'sid', sid: 'full-test'});
    expect(events[1]).toMatchObject({type: 'stage', stage: 'script', state: 'running'});
    expect(events[2]).toMatchObject({type: 'stage', stage: 'script', state: 'done', elapsed_s: 3.5});
    expect(events[3]).toMatchObject({type: 'stage', stage: 'voice', state: 'running'});
    expect(events[4]).toMatchObject({type: 'stage', stage: 'voice', state: 'done', elapsed_s: 12.0});
    expect(events[5]).toEqual({type: 'done', sid: 'full-test', gates});
  });
});

// ---------------------------------------------------------------------------
// 5) Resilience: malformed + non-data lines
// ---------------------------------------------------------------------------
describe('readSse — resilience', () => {
  it('skips frames with no data: line (e.g. comment-only SSE frames)', async () => {
    const events = await collect([
      ': keep-alive\n\n',
      'data: {"type":"sid","sid":"ok"}\n\n',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('sid');
  });

  it('skips frames with malformed JSON', async () => {
    const events = await collect([
      'data: {broken json}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
  });

  it('silently ignores unknown event types', async () => {
    const events = await collect([
      'data: {"type":"progress","value":0.5}\n\n',
      'data: {"type":"sid","sid":"after-unknown"}\n\n',
    ]);
    // 'progress' is not in SseEvent — ignored; 'sid' is dispatched
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'sid', sid: 'after-unknown'});
  });

  it('gracefully handles a final frame with no trailing \\n\\n', async () => {
    // Stream ends without the trailing double-newline — residual flushed.
    const events = await collect([
      'data: {"type":"sid","sid":"no-tail"}',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'sid', sid: 'no-tail'});
  });

  it('does not call onEvent when stream is empty', async () => {
    const onEvent = vi.fn();
    await readSse(mockResponse([]), onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6) Accepts a raw ReadableStream (not just Response)
// ---------------------------------------------------------------------------
describe('readSse — accepts ReadableStream directly', () => {
  it('works when passed a ReadableStream<Uint8Array> instead of Response', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"type":"sid","sid":"raw-stream"}\n\n'));
        controller.close();
      },
    });
    const events: SseEvent[] = [];
    await readSse(stream, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'sid', sid: 'raw-stream'});
  });
});
