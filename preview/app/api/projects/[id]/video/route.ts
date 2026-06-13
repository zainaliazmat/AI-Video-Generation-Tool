// preview/app/api/projects/[id]/video/route.ts
import {createReadStream, statSync, existsSync} from 'node:fs';
import {Readable} from 'node:stream';
import path from 'node:path';
import {isValidProjectId} from '@/lib/projects';
import {projectDir} from '@/lib/projects-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRange(range: string, size: number): {start: number; end: number} | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start: number;
  let end: number;
  if (s === '') {
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

function toResponseBody(stream: ReturnType<typeof createReadStream>, signal: AbortSignal) {
  stream.on('error', () => stream.destroy());
  if (signal.aborted) stream.destroy();
  else signal.addEventListener('abort', () => stream.destroy(), {once: true});
  return Readable.toWeb(stream) as ReadableStream;
}

export async function GET(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!isValidProjectId(id)) return new Response('Invalid id', {status: 400});
  const file = path.join(projectDir(id), 'video.mp4');
  if (!existsSync(file)) return new Response('Not rendered', {status: 404});

  const size = statSync(file).size;
  const rangeHeader = req.headers.get('range');
  // no-store so a re-rendered project's MP4 isn't served stale from cache.
  const base = {'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store'};

  if (rangeHeader) {
    const r = parseRange(rangeHeader, size);
    if (!r) {
      return new Response('Invalid range', {status: 416, headers: {'content-range': `bytes */${size}`}});
    }
    const stream = createReadStream(file, {start: r.start, end: r.end});
    return new Response(toResponseBody(stream, req.signal), {
      status: 206,
      headers: {
        ...base,
        'content-range': `bytes ${r.start}-${r.end}/${size}`,
        'content-length': String(r.end - r.start + 1),
      },
    });
  }

  const stream = createReadStream(file);
  return new Response(toResponseBody(stream, req.signal), {
    status: 200,
    headers: {...base, 'content-length': String(size), 'content-disposition': 'inline; filename="video.mp4"'},
  });
}
