import {spawn, type ChildProcess} from 'node:child_process';
import {copyFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

// child_process + fs are Node-only; never bundle this for Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel-only hint; locally we enforce our own hard timeout below.
export const maxDuration = 600;

// The dev server's cwd is preview/; remotion/ is its sibling.
const REMOTION_DIR = path.resolve(process.cwd(), '..', 'remotion');
// Hard cap so a wedged render can't peg this CPU-only box forever.
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;

// Single-flight: one render at a time (shared out/video.mp4). Best-effort —
// module state, so a dev hot-reload could reset it; fine for a single user.
let rendering = false;

export async function POST(req: Request) {
  let id = '';
  try {
    const body = await req.json();
    id = typeof body?.id === 'string' ? body.id.trim() : '';
  } catch {
    id = '';
  }
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return new Response(JSON.stringify({error: 'A valid project "id" is required to render.'}), {
      status: 400, headers: {'content-type': 'application/json'},
    });
  }

  if (rendering) {
    return new Response(JSON.stringify({error: 'A render is already in progress.'}), {
      status: 409,
      headers: {'content-type': 'application/json'},
    });
  }
  rendering = true;

  const encoder = new TextEncoder();
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Kill the whole process group (npm -> remotion render -> chrome), not just
  // npm — otherwise the render keeps running after a cancel/timeout.
  const killChild = () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  };

  const teardown = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    rendering = false;
  };

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Stream already closed (client disconnected) — stop sending.
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // `npm run render` = copy-spec (stages remotion/public/sample-spec.json) +
      // `remotion render Video out/video.mp4` (config: jpeg / concurrency 2 / 120s).
      child = spawn('npm', ['run', 'render'], {
        cwd: REMOTION_DIR, // MUST be remotion/ — matches the verified render path
        env: {...process.env, SPEC_PATH: `projects/${id}/spec.json`}, // inherit PATH so npm/node/Chrome resolve
        shell: false,
        detached: true, // own process group so killChild() tears down the tree
      });

      timer = setTimeout(() => {
        send({type: 'error', message: `Render timed out after ${RENDER_TIMEOUT_MS / 60000} min`});
        killChild();
        finish();
      }, RENDER_TIMEOUT_MS);

      send({type: 'start'});

      let total = 0;
      // Anchor on Remotion's "Rendered X/N" lines only. Parsing bare "x/y"
      // would match stray substrings (paths, timestamps); parsing "Encoded"
      // too would make progress jump backward at the encode phase.
      const onChunk = (buf: Buffer) => {
        const matches = [...buf.toString().matchAll(/Rendered\s+(\d+)\s*\/\s*(\d+)/g)];
        const last = matches[matches.length - 1];
        if (last) {
          const frame = Number(last[1]);
          total = Number(last[2]) || total;
          send({type: 'progress', frame, total, progress: total ? frame / total : 0});
        }
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk); // Remotion logs to both depending on TTY

      child.on('error', (err) => {
        send({type: 'error', message: err.message});
        finish();
      });
      child.on('close', (code) => {
        if (code === 0) {
          try {
            const src = path.resolve(REMOTION_DIR, 'out', 'video.mp4');
            const destDir = path.resolve(REMOTION_DIR, '..', 'projects', id);
            mkdirSync(destDir, {recursive: true});
            copyFileSync(src, path.join(destDir, 'video.mp4'));
          } catch (e) {
            send({type: 'error', message: `Render saved but archiving failed: ${(e as Error).message}`});
            finish();
            return;
          }
          send({type: 'done', id, output: `/api/projects/${id}/video`});
        } else {
          send({type: 'error', message: `Render exited with code ${code}`});
        }
        finish();
      });
    },
    cancel() {
      // Client disconnected mid-render: kill the render tree and release the
      // lock, otherwise it keeps burning CPU and 409s every future request.
      killChild();
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
