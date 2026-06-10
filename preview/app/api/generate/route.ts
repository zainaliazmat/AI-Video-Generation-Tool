import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';

// child_process is Node-only; never bundle this for Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

// The dev server's cwd is preview/; the repo root is its parent.
const PREVIEW_DIR = process.cwd();
const REPO_ROOT = path.resolve(PREVIEW_DIR, '..');
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');
const MAIN = path.join(REPO_ROOT, 'backend', 'main.py');
// CPU-only box: a full run is ~3 min; cap generously so a wedged stage can't hang forever.
const GENERATE_TIMEOUT_MS = 12 * 60 * 1000;

// Single-flight: one generation at a time (shared spec.json + assets dir).
let generating = false;

export async function POST(req: Request) {
  let topic = '';
  try {
    const body = await req.json();
    topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
  } catch {
    topic = '';
  }
  if (!topic) {
    return new Response(JSON.stringify({error: 'A non-empty "topic" is required.'}), {
      status: 400,
      headers: {'content-type': 'application/json'},
    });
  }
  if (generating) {
    return new Response(JSON.stringify({error: 'A generation is already in progress.'}), {
      status: 409,
      headers: {'content-type': 'application/json'},
    });
  }
  generating = true;

  const encoder = new TextEncoder();
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Kill the whole process group (python and any children) on cancel/timeout.
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
    generating = false;
  };

  // Stage the freshly generated spec.json + assets into preview/public so the
  // Player (which serves from THIS app's public/) sees the new video.
  const stageAssets = () =>
    new Promise<void>((resolve) => {
      const cp = spawn('npm', ['run', 'copy-assets'], {
        cwd: PREVIEW_DIR,
        env: process.env,
        shell: false,
      });
      cp.on('error', () => resolve()); // best-effort; don't fail the whole run on a copy hiccup
      cp.on('close', () => resolve());
    });

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let stderrTail = '';
      let sid: string | null = null;

      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
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

      child = spawn(PYTHON, [MAIN, '--topic', topic, '--progress-json'], {
        cwd: REPO_ROOT, // .env loads here; spec.json + assets resolve relative to it
        env: process.env,
        shell: false,
        detached: true, // own process group so killChild() tears down the tree
      });

      timer = setTimeout(() => {
        send({type: 'error', message: `Generation timed out after ${GENERATE_TIMEOUT_MS / 60000} min`});
        killChild();
        finish();
      }, GENERATE_TIMEOUT_MS);

      send({type: 'start'});

      // stdout carries the machine-readable PROGRESS lines.
      let stdoutBuf = '';
      child.stdout?.on('data', (buf: Buffer) => {
        stdoutBuf += buf.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const i = line.indexOf('PROGRESS ');
          if (i === -1) continue;
          try {
            const evt = JSON.parse(line.slice(i + 'PROGRESS '.length));
            if (evt?.stage === 'session' && typeof evt.state === 'string') {
              sid = evt.state; // the resumable session id — not a pipeline stage
            } else if (evt && typeof evt.stage === 'string' && typeof evt.state === 'string') {
              send({type: 'stage', stage: evt.stage, state: evt.state});
            }
          } catch {
            // ignore a partial/garbled progress line
          }
        }
      });

      // stderr carries human logs + any traceback; keep the tail for error reporting.
      child.stderr?.on('data', (buf: Buffer) => {
        stderrTail = (stderrTail + buf.toString()).slice(-2000);
      });

      child.on('error', (err) => {
        send({type: 'error', message: err.message});
        finish();
      });
      child.on('close', async (code) => {
        if (code === 0) {
          await stageAssets();
          send({type: 'done', spec: '/spec.json', sid});
        } else {
          const tail = stderrTail.trim().split('\n').slice(-3).join('\n');
          send({type: 'error', message: `Generation failed (exit ${code})${tail ? `: ${tail}` : ''}`});
        }
        finish();
      });
    },
    cancel() {
      // Client disconnected: kill the pipeline and release the lock.
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
