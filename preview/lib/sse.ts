// Shared SSE frame reader — framework-agnostic (no React), no Next.js imports.
// Extracted from the verbatim pattern in app/page.tsx (generate) and
// components/RenderControls.tsx (render).  T1/T8 may adopt it later.
//
// Wire protocol (emitted by /api/session/start + /api/session/[id]/approve):
//   data: {"type":"sid","sid":"..."}
//   data: {"type":"stage","stage":"script","state":"running"}
//   data: {"type":"stage","stage":"script","state":"done","elapsed_s":4.2}
//   data: {"type":"done","sid":"...","gates":{...}}
//   data: {"type":"error","error":"..."}
//
// Frames are separated by \n\n; a frame can be split across chunks.

import type {GatesDict} from './studio';

export type SseEvent =
  | {type: 'sid'; sid: string}
  | {type: 'stage'; stage: string; state: 'running' | 'done' | 'failed'; elapsed_s?: number; error?: string}
  | {type: 'done'; sid?: string; gates?: GatesDict | null}
  | {type: 'error'; error?: string; message?: string};

/**
 * Consume an SSE response (or raw ReadableStream<Uint8Array>), parse every
 * `data: <json>` frame, and call onEvent for each typed event.
 *
 * Split-frame handling: we accumulate chunks in a string buffer and only slice
 * on `\n\n` boundaries, so a frame whose bytes are spread across two (or more)
 * network reads is reassembled correctly before parsing.
 *
 * A final residual in the buffer after the stream ends (i.e. a line without a
 * trailing `\n\n`) is attempted once as a last frame so we never silently drop
 * a terminal event.
 */
export async function readSse(
  res: Response | ReadableStream<Uint8Array>,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const stream: ReadableStream<Uint8Array> =
    res instanceof Response ? (res.body as ReadableStream<Uint8Array>) : res;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchFrame = (frame: string): void => {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line.slice(6)) as Record<string, unknown>;
    } catch {
      return; // malformed frame — skip
    }
    const type = msg.type as string;
    if (type === 'sid') {
      onEvent({type: 'sid', sid: msg.sid as string});
    } else if (type === 'stage') {
      const ev: SseEvent = {
        type: 'stage',
        stage: msg.stage as string,
        state: msg.state as 'running' | 'done' | 'failed',
      };
      if (msg.elapsed_s != null) (ev as {elapsed_s?: number}).elapsed_s = msg.elapsed_s as number;
      if (msg.error != null) (ev as {error?: string}).error = msg.error as string;
      onEvent(ev);
    } else if (type === 'done') {
      onEvent({
        type: 'done',
        sid: typeof msg.sid === 'string' ? msg.sid : undefined,
        gates: (msg.gates as GatesDict | null | undefined) ?? undefined,
      });
    } else if (type === 'error') {
      onEvent({
        type: 'error',
        error: typeof msg.error === 'string' ? msg.error : undefined,
        message: typeof msg.message === 'string' ? msg.message : undefined,
      });
    }
    // unknown types are silently ignored
  };

  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    const frames = buffer.split('\n\n');
    // Last element may be an incomplete frame — keep it in the buffer.
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      dispatchFrame(frame);
    }
  }

  // Flush any residual bytes left in the decoder.
  const tail = decoder.decode();
  if (tail) buffer += tail;

  // Attempt the residual as a final (unterminated) frame — covers the case where
  // the server closes the connection without a trailing \n\n.
  if (buffer.trim()) {
    dispatchFrame(buffer);
  }
}
