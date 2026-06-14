import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {inFlight} from '../../../../lib/sessionFlight';
import {copyAssets} from '../../../../lib/copyAssets';

// child_process is Node-only; never bundle this for Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;

// The dev server's cwd is preview/; the repo root is its parent.
const PREVIEW_DIR = process.cwd();
const REPO_ROOT = path.resolve(PREVIEW_DIR, '..');
const PYTHON = path.join(REPO_ROOT, 'backend', '.venv', 'bin', 'python');
const SESSION_GATE = path.join(REPO_ROOT, 'backend', 'session_gate.py');

// Session timeout: a full start run (script + maybe more in auto-run) can be long.
const START_TIMEOUT_MS = 15 * 60 * 1000;

// inFlight is imported from lib/sessionFlight (ruling 4A: single shared Map
// across start + approve routes; duplicate concurrent request for same sid → 409).
// NOTE: for --op start, the sid isn't known until the CLI emits the sid-first PROGRESS event
// (it's generated server-side by the Python process). We register the in-flight key when
// that event arrives, so we cannot 409-by-sid before then. That's fine by design.

export async function POST(req: Request) {
  let topic = '';
  let autoRun = false;
  let targetLength: number | undefined;
  let prefsOverride: Record<string, unknown> | undefined;
  try {
    const body = await req.json();
    topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
    autoRun = body?.autoRun === true;
    if (typeof body?.targetLength === 'number') targetLength = body.targetLength;
    // Per-video script-style override (object of set fields). Ignore empties so the
    // additive prompt block stays byte-identical when nothing is tweaked.
    if (body?.prefsOverride && typeof body.prefsOverride === 'object' &&
        Object.keys(body.prefsOverride).length > 0) {
      prefsOverride = body.prefsOverride as Record<string, unknown>;
    }
  } catch {
    topic = '';
  }
  if (!topic) {
    return new Response(JSON.stringify({error: 'A non-empty "topic" is required.'}), {
      status: 400,
      headers: {'content-type': 'application/json'},
    });
  }

  const encoder = new TextEncoder();
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let trackedSid: string | null = null;

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
    if (trackedSid) {
      inFlight.delete(trackedSid);
      trackedSid = null;
    }
  };

  const args: string[] = ['--op', 'start', '--topic', topic];
  if (autoRun) args.push('--auto-run');
  if (targetLength !== undefined) args.push('--target-length', String(targetLength));
  if (prefsOverride) args.push('--prefs-override-json', JSON.stringify(prefsOverride));

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let stderrTail = '';
      let finalSid: string | null = null;
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
        send({type: 'error', message: `Session start timed out after ${START_TIMEOUT_MS / 60000} min`});
        killChild();
        finish();
      }, START_TIMEOUT_MS);

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
              if (evt?.type === 'sid') {
                // sid-first event: register in-flight key now (ruling 4A comment above)
                finalSid = evt.sid;
                trackedSid = evt.sid;
                inFlight.set(evt.sid, true);
                send({type: 'sid', sid: evt.sid});
              } else if (evt?.type === 'stage') {
                send({type: 'stage', stage: evt.stage, state: evt.state, ...(evt.elapsed_s != null ? {elapsed_s: evt.elapsed_s} : {}), ...(evt.error ? {error: evt.error} : {})});
              }
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
                  send({type: 'error', error: result.error ?? 'start failed'});
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
          // Auto-run may build the whole pipeline (voiceover + footage) before the
          // UI lands on a gate; mirror those into preview/public so the live player
          // can fetch them instead of buffering forever. copyAssets never rejects.
          await copyAssets();
          send({type: 'done', sid: finalSid, gates: finalGates});
        } else {
          const tail = stderrTail.trim().split('\n').slice(-3).join('\n');
          send({type: 'error', error: `Session start failed (exit ${code})${tail ? `: ${tail}` : ''}`});
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
