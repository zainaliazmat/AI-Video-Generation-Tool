import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {inFlight} from '../../../../../lib/sessionFlight';
import {copyAssets} from '../../../../../lib/copyAssets';

// child_process is Node-only; never bundle this for Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

// The dev server's cwd is preview/; the repo root is its parent.
const PREVIEW_DIR = process.cwd();
const REPO_ROOT = path.resolve(PREVIEW_DIR, '..');
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');
const SESSION_GATE = path.join(REPO_ROOT, 'backend', 'session_gate.py');

// Approve timeout: voice+scenes approval can be long (TTS + footage fetch).
const APPROVE_TIMEOUT_MS = 15 * 60 * 1000;

// inFlight is imported from lib/sessionFlight (ruling 4A: single shared Map
// across start + approve routes; duplicate concurrent request for same sid → 409).

export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const {id: sid} = await params;

  // 409 if a concurrent approve is already running for this sid (ruling 4A).
  if (inFlight.has(sid)) {
    return new Response(JSON.stringify({error: 'session busy'}), {
      status: 409,
      headers: {'content-type': 'application/json'},
    });
  }

  let gate = '';
  let voice: string | undefined;
  let speed: number | undefined;
  try {
    const body = await req.json();
    gate = typeof body?.gate === 'string' ? body.gate.trim() : '';
    if (typeof body?.voice === 'string') voice = body.voice;
    if (typeof body?.speed === 'number') speed = body.speed;
  } catch {
    gate = '';
  }
  if (!gate) {
    return new Response(JSON.stringify({error: 'A non-empty "gate" is required.'}), {
      status: 400,
      headers: {'content-type': 'application/json'},
    });
  }

  // Register in-flight before spawning (ruling 4A: claim before first await).
  inFlight.set(sid, true);

  const encoder = new TextEncoder();
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
    inFlight.delete(sid);
  };

  const args: string[] = ['--op', 'approve', '--sid', sid, '--gate', gate];
  if (voice !== undefined) args.push('--voice', voice);
  if (speed !== undefined) args.push('--speed', String(speed));

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let stderrTail = '';
      let finalGates: unknown = null;

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

      child = spawn(PYTHON, [SESSION_GATE, ...args], {
        cwd: REPO_ROOT,
        env: process.env,
        shell: false,
        detached: true,
      });

      timer = setTimeout(() => {
        send({type: 'error', message: `Gate approve timed out after ${APPROVE_TIMEOUT_MS / 60000} min`});
        killChild();
        finish();
      }, APPROVE_TIMEOUT_MS);

      // stdout carries PROGRESS lines followed by a single final JSON line.
      let stdoutBuf = '';
      child.stdout?.on('data', (buf: Buffer) => {
        stdoutBuf += buf.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const progressIdx = line.indexOf('PROGRESS ');
          if (progressIdx !== -1) {
            // PROGRESS event
            try {
              const evt = JSON.parse(line.slice(progressIdx + 'PROGRESS '.length));
              if (evt?.type === 'stage') {
                send({type: 'stage', stage: evt.stage, state: evt.state, ...(evt.elapsed_s != null ? {elapsed_s: evt.elapsed_s} : {}), ...(evt.error ? {error: evt.error} : {})});
              }
              // approve never emits a sid-first event
            } catch {
              // ignore garbled progress line
            }
          } else {
            // Attempt to parse as the final JSON result line
            const trimmed = line.trim();
            if (trimmed.startsWith('{')) {
              try {
                const result = JSON.parse(trimmed);
                if (result?.ok === true) {
                  // Extract the gates dict from final result (CLI returns {ok, sid, gates, autoRun, currentStage})
                  finalGates = result.gates ?? null;
                } else if (result?.ok === false) {
                  // CLI-level failure (non-zero exit handled in close; this is belt+suspenders)
                  send({type: 'error', error: result.error ?? 'approve failed'});
                }
              } catch {
                // not a JSON result line — ignore
              }
            }
          }
        }
      });

      child.stderr?.on('data', (buf: Buffer) => {
        stderrTail = (stderrTail + buf.toString()).slice(-2000);
      });

      child.on('error', (err) => {
        send({type: 'error', error: err.message});
        finish();
      });
      child.on('close', async (code) => {
        if (code === 0) {
          // Mirror the new voiceover + footage into preview/public BEFORE the UI
          // navigates to the scenes gate, or the live player 404s on assets and
          // buffers forever (the "stuck loading" bug). copyAssets never rejects.
          await copyAssets();
          send({type: 'done', gates: finalGates});
        } else {
          const tail = stderrTail.trim().split('\n').slice(-3).join('\n');
          send({type: 'error', error: `Gate approve failed (exit ${code})${tail ? `: ${tail}` : ''}`});
        }
        finish();
      });
    },
    cancel() {
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
