// Studio v3 M6 T1 — Topic screen helpers (pure, no React/Next.js imports).
//
// Exported as a module so vitest (environment:'node') can exercise the
// LENHINT map and the Generate-flow event handler without jsdom.

/** The four valid target-length presets (seconds). */
export type TargetLength = 30 | 60 | 180 | 300;

/** Labels for the length preset chips (as shown in the UI). */
export const LENGTH_CHIP_LABELS: Record<TargetLength, string> = {
  30: '30 s',
  60: '60 s',
  180: '3 min',
  300: '5 min',
};

/** Default length preset. */
export const DEFAULT_TARGET_LENGTH: TargetLength = 60;

/**
 * LENHINT map — exact copy from mock §1 (`studio-v3-staged-flow-mock (1).html`
 * var LENHINT).  Never edit these strings without updating the mock + plan.
 */
export const LENHINT: Record<TargetLength, string> = {
  30: '~5–6 beats · one sentence each · rapid cuts',
  60: '~7–9 beats · one sentence each · the classic short',
  180: '~22–30 beats · beats stretch to 2–3 sentences so cuts stay calm',
  300: '~38–48 beats · 2–3 sentence beats · verify caps scale up',
};

// ---------------------------------------------------------------------------
// Generate-flow pure handler
// ---------------------------------------------------------------------------
//
// The Generate button in page.tsx calls studio.session.start() and pipes the
// streaming Response through readSse.  The SseEvent handling logic below is
// extracted as a pure function so vitest can test it without jsdom or routing.
//
// Ruling 2 (plan review): on {type:'sid', sid} → navigate to /video/[sid]/script
// IMMEDIATELY — the script segment runs server-side during start and the script
// page polls /state.  Error events arriving before any sid → show failed state.
//
// NOTE for T3 (script page): When `start` navigates to /video/[sid]/script the
// script segment may still be running server-side.  The script page MUST poll
// studio.session.state(sid) on mount and show a "writing your script…" interstitial
// until gates.script is 'awaiting_approval', then render the gate UI.

export type GenerateFlowCallbacks = {
  /** Called when the sid arrives — navigate immediately (ruling 2). */
  onSid: (sid: string) => void;
  /** Called when a stage event arrives (optional — for progress display). */
  onStage?: (stage: string, state: 'running' | 'done' | 'failed', elapsed_s?: number) => void;
  /** Called when the stream ends normally (done event, no sid yet — shouldn't
   *  happen per protocol but handle gracefully). */
  onDone?: () => void;
  /** Called on an error event BEFORE any sid — show failed state on topic screen. */
  onError: (message: string) => void;
};

/**
 * Process a single SseEvent from the start stream.
 * Returns true if processing should stop (sid navigated or terminal error seen).
 */
export function handleStartSseEvent(
  event: {type: string; sid?: string; stage?: string; state?: string; elapsed_s?: number; error?: string; message?: string},
  callbacks: GenerateFlowCallbacks,
  sidReceived: {value: boolean},
): boolean {
  if (event.type === 'sid' && typeof event.sid === 'string') {
    sidReceived.value = true;
    callbacks.onSid(event.sid);
    return true; // navigate immediately — stop consuming
  }

  if (event.type === 'stage' && callbacks.onStage) {
    callbacks.onStage(
      event.stage ?? '',
      (event.state as 'running' | 'done' | 'failed') ?? 'running',
      event.elapsed_s,
    );
    return false;
  }

  if (event.type === 'done') {
    // done without a prior sid — shouldn't happen per protocol; treat as success
    callbacks.onDone?.();
    return true;
  }

  if (event.type === 'error') {
    if (!sidReceived.value) {
      // Error before sid: show failed state on the topic screen
      const msg = event.error ?? event.message ?? 'Script generation failed';
      callbacks.onError(msg);
    }
    return true;
  }

  return false;
}
