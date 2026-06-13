'use client';

// Studio v3 M6 — GateInterstitial (F3b).
//
// Shown in-pane while an approve (or start) SSE stream runs.  Consumes the
// stream via readSse, renders a per-task card per the mock interstitial
// vocabulary, handles failures with a Retry button, and polls /state on 409
// reconnected-mode (ruling 6 / ruling 7A).
//
// Visual vocabulary mirrors the mock `.task` / `.taskcard` / `.interfn` shapes:
//   • pending: dim icon ring + dim text
//   • running: tinted spinner inside the icon ring (NOT .stale-dot — that is for
//     the stepper; here we render a CSS-spin border inside the pip)
//   • done:    green ring + ✓ + trailing elapsed_s in mono
//   • failed:  red ring + ✗ + verbatim error below the card

import {useEffect, useRef, useState} from 'react';
import {cn} from '@/lib/cn';
import {readSse} from '@/lib/sse';
import type {SseEvent} from '@/lib/sse';
import type {GatesDict} from '@/lib/studio';
import {studio} from '@/lib/studio';
import {Button} from '@/components/ui';

// ─── types ────────────────────────────────────────────────────────────────────

export interface GateTask {
  key: string;
  label: string;
}

type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

interface TaskState {
  status: TaskStatus;
  elapsed_s?: number;
  error?: string;
}

export interface GateInterstitialProps {
  /** Thunk that POSTs and returns the streaming Response (studio.session.approve/start). */
  stream: () => Promise<Response>;
  /** Expected stage cards in order (per-gate, matching the interstitial vocabulary). */
  tasks?: GateTask[];
  /** Called when the stream finishes successfully (type:done). */
  onDone: (gates?: GatesDict, sid?: string) => void;
  /** Called when an unrecoverable error happens (after the user closes or no Retry). */
  onError?: (msg: string) => void;
  /** Session id — used for /state polling in reconnected-mode (409). */
  sid?: string;
  /** Per-preset footnote copy: "~N min — you can leave, it keeps building". */
  leaveCopy?: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Elapsed seconds formatted as "N.N s" or "<1 s". */
function fmtElapsed(elapsed_s: number): string {
  if (elapsed_s < 1) return '<1 s';
  return `${elapsed_s.toFixed(1).replace(/\.0$/, '')} s`;
}

// ─── component ────────────────────────────────────────────────────────────────

export function GateInterstitial({
  stream,
  tasks = [],
  onDone,
  onError,
  sid,
  leaveCopy,
}: GateInterstitialProps) {
  // Per-task display state keyed by GateTask.key
  const [taskStates, setTaskStates] = useState<Record<string, TaskState>>(() =>
    Object.fromEntries(tasks.map((t) => [t.key, {status: 'pending'}])),
  );

  // Whether we have a failed card visible (any stage failed OR type:error/type:failed).
  const [failedMsg, setFailedMsg] = useState<string | null>(null);

  // Reconnected-mode: 409 was received — polling /state
  const [reconnecting, setReconnecting] = useState(false);

  // Elapsed wall-clock tick for the running stage
  const [elapsedTick, setElapsedTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track the current running stage key so we can tick it
  const runningKeyRef = useRef<string | null>(null);

  // Abort controller for the polling loop
  const pollAbortRef = useRef<AbortController | null>(null);

  // Whether we have started streaming at all (avoid double-start in StrictMode)
  const startedRef = useRef(false);

  // ── timer helpers ───────────────────────────────────────────────────────────

  const startTick = () => {
    if (tickRef.current) clearInterval(tickRef.current);
    setElapsedTick(0);
    tickRef.current = setInterval(() => {
      setElapsedTick((n) => n + 1);
    }, 1000);
  };

  const stopTick = () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  };

  // ── SSE event handler ───────────────────────────────────────────────────────

  const handleEvent = (e: SseEvent) => {
    if (e.type === 'stage') {
      const {stage, state, elapsed_s, error} = e;
      setTaskStates((prev) => {
        // Match the stage name against a task key (the task key IS the stage name
        // emitted by the backend: 'script', 'voice', 'timing', etc.)
        const matched = tasks.find((t) => t.key === stage);
        if (!matched) {
          // Unknown stage — add a synthetic entry so the user sees it
          return {
            ...prev,
            [stage]: {
              status: state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'running',
              ...(elapsed_s != null ? {elapsed_s} : {}),
              ...(error ? {error} : {}),
            },
          };
        }
        const newStatus: TaskStatus =
          state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'running';
        return {...prev, [stage]: {status: newStatus, elapsed_s, error}};
      });

      if (state === 'running') {
        runningKeyRef.current = stage;
        startTick();
      } else if (state === 'done' || state === 'failed') {
        stopTick();
        runningKeyRef.current = null;
        if (state === 'failed') {
          const errMsg = error ?? 'Stage failed';
          setFailedMsg(errMsg);
          onError?.(errMsg);
        }
      }
    } else if (e.type === 'done') {
      stopTick();
      onDone(e.gates ?? undefined, e.sid ?? undefined);
    } else if (e.type === 'error') {
      stopTick();
      const msg = e.error ?? e.message ?? 'Unknown error';
      setFailedMsg(msg);
      onError?.(msg);
    }
  };

  // ── reconnected-mode polling ──────────────────────────────────────────────

  const startPolling = (targetSid: string) => {
    setReconnecting(true);
    const abort = new AbortController();
    pollAbortRef.current = abort;

    const poll = async () => {
      while (!abort.signal.aborted) {
        try {
          const state = await studio.session.state(targetSid);
          // Check whether ANY gate moved from the initial state we care about.
          // We treat any gates response as "done enough" — the caller's onDone
          // will re-read /state if it needs to.  The heuristic: if at least one
          // gate is approved or awaiting_approval we consider the stream done.
          const gates = state.gates ?? {};
          const gateDone = Object.values(gates).some(
            (g) => g.state === 'approved' || g.state === 'awaiting_approval',
          );
          if (gateDone) {
            setReconnecting(false);
            abort.abort();
            onDone(gates, state.sid);
            return;
          }
        } catch {
          // network error — keep trying
        }
        // Wait ~2 s between polls
        await new Promise<void>((res) => {
          const id = setTimeout(res, 2000);
          abort.signal.addEventListener('abort', () => {
            clearTimeout(id);
            res();
          });
        });
      }
    };

    poll();
  };

  // ── stream runner ─────────────────────────────────────────────────────────

  const run = async () => {
    // Reset state for Retry
    setFailedMsg(null);
    setReconnecting(false);
    setElapsedTick(0);
    stopTick();
    setTaskStates(Object.fromEntries(tasks.map((t) => [t.key, {status: 'pending'}])));

    let res: Response;
    try {
      res = await stream();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFailedMsg(msg);
      onError?.(msg);
      return;
    }

    // 409 → reconnected-mode (session busy — another tab/request is running)
    if (res.status === 409) {
      if (sid) {
        startPolling(sid);
      } else {
        const msg = 'Session busy — no sid provided for reconnect polling';
        setFailedMsg(msg);
        onError?.(msg);
      }
      return;
    }

    if (!res.ok && res.status !== 200) {
      let msg = `Approve failed (HTTP ${res.status})`;
      try {
        const body = (await res.json()) as {error?: string};
        if (body?.error) msg = body.error;
      } catch {
        // ignore JSON parse failure
      }
      setFailedMsg(msg);
      onError?.(msg);
      return;
    }

    try {
      await readSse(res, handleEvent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFailedMsg(msg);
      onError?.(msg);
    }
  };

  // ── initial auto-run + cleanup ────────────────────────────────────────────

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    run();
    return () => {
      stopTick();
      pollAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── render ────────────────────────────────────────────────────────────────

  // Build a display list: original tasks + any synthetic stages not in tasks
  const displayKeys = [
    ...tasks.map((t) => t.key),
    ...Object.keys(taskStates).filter((k) => !tasks.find((t) => t.key === k)),
  ];
  const displayTasks = displayKeys.map((key) => ({
    key,
    label: tasks.find((t) => t.key === key)?.label ?? key,
    state: taskStates[key] ?? {status: 'pending' as TaskStatus},
  }));

  return (
    <div
      className={cn(
        'content-card mx-auto max-w-[480px] px-[22px] pb-[18px] pt-[22px]',
        'mt-[80px]',
      )}
      role="region"
      aria-label="Pipeline progress"
    >
      {/* Task list — aria-live for stage transitions */}
      <div aria-live="polite" aria-atomic="false">
        {displayTasks.map(({key, label, state: ts}) => {
          const isRunning = ts.status === 'running';
          const isDone = ts.status === 'done';
          const isFailed = ts.status === 'failed';

          return (
            <div
              key={key}
              className={cn(
                'flex items-center gap-[11px] px-0.5 py-[9px]',
                'font-ui text-[13.5px] font-[550]',
                'transition-colors duration-300',
                isDone && 'text-ink-secondary',
                isRunning && 'text-ink',
                isFailed && 'text-[#f87171]',
                !isRunning && !isDone && !isFailed && 'text-ink-muted',
              )}
            >
              {/* Icon pip */}
              <span
                className={cn(
                  'relative flex h-[20px] w-[20px] flex-none items-center justify-center rounded-full',
                  'text-[10px] transition-all duration-300',
                  !isRunning && !isDone && !isFailed && 'bg-white/[0.12] text-ink-muted',
                  isRunning && 'bg-warn-soft text-warn',
                  isDone && 'bg-[rgba(48,209,88,0.16)] text-[#30d158]',
                  isFailed && 'bg-[rgba(239,68,68,0.15)] text-[#f87171]',
                )}
                aria-hidden="true"
              >
                {isDone && '✓'}
                {isFailed && '✗'}
                {isRunning && (
                  // CSS-spin border — the mock .task.run i::after pattern
                  <span
                    className={cn(
                      'absolute h-[9px] w-[9px] rounded-full',
                      'border-2 border-warn border-t-transparent',
                      'animate-spin',
                    )}
                    style={{animationDuration: '0.7s', animationTimingFunction: 'linear'}}
                  />
                )}
              </span>

              {/* Label */}
              <span className="flex-1">{label}</span>

              {/* Elapsed — shown when done; ticking seconds when running */}
              {isDone && ts.elapsed_s != null && (
                <span
                  className="ml-auto font-mono text-[10.5px] text-ink-muted tabular-nums"
                  aria-label={`Completed in ${fmtElapsed(ts.elapsed_s)}`}
                >
                  {fmtElapsed(ts.elapsed_s)}
                </span>
              )}
              {isRunning && (
                <span
                  className="ml-auto font-mono text-[10.5px] text-ink-muted tabular-nums"
                  // NOT in aria-live region to avoid spamming screen readers
                  aria-hidden="true"
                >
                  {elapsedTick} s
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Failed card — verbatim error + Retry */}
      {failedMsg !== null && (
        <div
          className={cn(
            'mt-3 rounded-[10px] px-3 py-2.5',
            'bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.2)]',
          )}
          role="alert"
        >
          <p className="mb-2.5 font-mono text-[11.5px] text-[#f87171]">{failedMsg}</p>
          <Button
            variant="danger"
            className="px-3 py-2 text-[12.5px]"
            onClick={() => {
              startedRef.current = false;
              run();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Reconnecting notice */}
      {reconnecting && !failedMsg && (
        <p className="mt-3 font-mono text-[11px] text-ink-muted" aria-live="polite">
          reconnecting…
        </p>
      )}

      {/* Leave-copy footnote */}
      {leaveCopy && (
        <p className="mt-[14px] text-center font-mono text-[11px] text-ink-muted">
          {leaveCopy}
        </p>
      )}
    </div>
  );
}
