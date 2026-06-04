import {createReadStream, statSync} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// remotion/out/video.mp4 lives outside preview/public/, so stream it here.
const OUTPUT = path.resolve(process.cwd(), '..', 'remotion', 'out', 'video.mp4');

/** Parse a single `bytes=start-end` range (incl. suffix `bytes=-N`). null = invalid. */
function parseRange(range: string, size: number): {start: number; end: number} | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;

  let start: number;
  let end: number;
  if (s === '') {
    // suffix range: the last N bytes
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === '' ? size - 1 : Number(e);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return {start, end: Math.min(end, size - 1)};
}

/** Node read stream -> Web stream, destroyed if the client aborts (no fd leak). */
function toResponseBody(stream: ReturnType<typeof createReadStream>, signal: AbortSignal) {
  stream.on('error', () => stream.destroy());
  if (signal.aborted) stream.destroy();
  else signal.addEventListener('abort', () => stream.destroy(), {once: true});
  return Readable.toWeb(stream) as ReadableStream;
}

export async function GET(req: Request) {
  let size: number;
  try {
    size = statSync(OUTPUT).size;
  } catch {
    return new Response('No render yet — click "Render MP4" first.', {status: 404});
  }

  const range = req.headers.get('range');
  if (range) {
    const parsed = parseRange(range, size);
    if (!parsed) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: {'content-range': `bytes */${size}`},
      });
    }
    const {start, end} = parsed;
    const stream = createReadStream(OUTPUT, {start, end});
    return new Response(toResponseBody(stream, req.signal), {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      },
    });
  }

  const stream = createReadStream(OUTPUT);
  return new Response(toResponseBody(stream, req.signal), {
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(size),
      'accept-ranges': 'bytes',
      'content-disposition': 'inline; filename="video.mp4"',
      'cache-control': 'no-store',
    },
  });
}
