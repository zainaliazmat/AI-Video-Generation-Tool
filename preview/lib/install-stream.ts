/**
 * install-stream.ts — bridge between the engine's callback-based onStage and
 * an async generator that yields SSEEvent objects.
 *
 * Keep-alive-on-disconnect (§16.15-1): unlike the render donor which kills the
 * child on client disconnect, the install route does NOT abort on disconnect.
 * install() runs to completion/rollback server-side — it already has no client
 * coupling. The UI re-syncs via GET /api/templates/state on reconnect.
 * We do NOT build live-stream re-attach (no server-side event buffer keyed by
 * install id) — server-side completion + state re-sync is the spec contract.
 */

import {
  install,
  installFromMarketplace,
  InstallError,
  type InstallResult,
} from '@installer';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SSEEvent =
  | {type: 'stage'; stage: string}
  | {type: 'done'; result: unknown}
  | {type: 'error'; stage: string; message: string};

type InstallInput =
  | {kind: 'zip'; zipPath: string}
  | {kind: 'catalog'; catalogId: string};

interface InstallOpts {
  update?: boolean;
  confirmReplace?: boolean;
}

// ---------------------------------------------------------------------------
// Queue-bridge helper
//
// Pattern: onStage callback pushes stage names into a shared queue and signals
// a waiter. The async generator drains the queue, yields SSEEvents, then awaits
// the next signal — or exits when the install promise has settled and the queue
// is empty.
// ---------------------------------------------------------------------------

class StageQueue {
  private queue: string[] = [];
  private notify: (() => void) | null = null;
  private settled = false;
  private settleFn: (() => void) | null = null;
  readonly promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((res) => {
      this.settleFn = res;
    });
  }

  /** Called by the onStage callback — always safe to call even after settled. */
  push(stage: string): void {
    this.queue.push(stage);
    const n = this.notify;
    this.notify = null;
    n?.();
  }

  /** Called when the install promise settles (resolved or rejected). */
  settle(): void {
    this.settled = true;
    const n = this.notify;
    this.notify = null;
    n?.();
    this.settleFn?.();
  }

  /**
   * Drain all currently queued stages, then yield stage SSEEvents.
   * After draining, if not yet settled, await a notification.
   * Repeat until settled AND queue is empty.
   */
  async *drain(): AsyncGenerator<SSEEvent> {
    while (true) {
      // Drain whatever is queued now
      while (this.queue.length > 0) {
        yield {type: 'stage', stage: this.queue.shift()!};
      }
      // If settled and queue is empty, we're done
      if (this.settled) break;
      // Otherwise wait for the next push() or settle()
      await new Promise<void>((res) => {
        this.notify = res;
        // If a push or settle happened between the queue check and this assignment,
        // the existing notify would already have been called — re-drain in that case.
        if (this.queue.length > 0 || this.settled) {
          this.notify = null;
          res();
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// runInstall — the public async generator
// ---------------------------------------------------------------------------

/**
 * Drive the installer engine and yield SSE events.
 *
 * Yields:
 *   - {type:'stage', stage} for each pipeline stage as it begins
 *   - {type:'done', result} on success
 *   - {type:'error', stage, message} on failure (InstallError or any error)
 *
 * The generator completes after the terminal event (done or error).
 */
export async function* runInstall(
  input: InstallInput,
  opts?: InstallOpts,
): AsyncGenerator<SSEEvent> {
  const q = new StageQueue();

  const onStage = (stage: string) => q.push(stage);

  // Start the install in the background; settle the queue when it resolves/rejects.
  let installResult: unknown = undefined;
  let installError: unknown = undefined;
  let isError = false;

  const installPromise = (
    input.kind === 'zip'
      ? install(input.zipPath, {
          update: opts?.update,
          confirmReplace: opts?.confirmReplace,
          onStage,
        })
      : installFromMarketplace(input.catalogId, {
          update: opts?.update,
          confirmReplace: opts?.confirmReplace,
          onStage,
        })
  )
    .then((result: InstallResult) => {
      installResult = result;
    })
    .catch((err: unknown) => {
      installError = err;
      isError = true;
    })
    .finally(() => {
      q.settle();
    });

  // Drain stage events as they arrive
  yield* q.drain();

  // Ensure the install promise is done (it should be, since settle() is called
  // in finally(), but await for correctness).
  await installPromise;

  // Emit terminal event
  if (isError) {
    const err: unknown = installError;
    if (err instanceof InstallError) {
      yield {type: 'error', stage: err.stage ?? 'install', message: err.message};
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      yield {type: 'error', stage: 'install', message: msg};
    }
  } else {
    yield {type: 'done', result: installResult};
  }
}
