/**
 * Studio v3 M6 T1 — Topic screen unit tests.
 *
 * 1. LENHINT map: exact strings + all four keys present.
 * 2. Chip selection coverage: each TargetLength → correct hint.
 * 3. Generate flow — handleStartSseEvent:
 *    a. sid event → onSid called, returns true (stop consuming).
 *    b. error-before-sid → onError called with the error message.
 *    c. error-after-sid → onError NOT called (sid already navigated).
 *    d. stage event → onStage called, returns false (keep consuming).
 *    e. done event without prior sid → onDone called.
 *    f. Unknown event type → ignored, returns false.
 */

import {describe, it, expect, vi} from 'vitest';
import {
  LENHINT,
  DEFAULT_TARGET_LENGTH,
  handleStartSseEvent,
  type GenerateFlowCallbacks,
} from './topicScreen';

// ---------------------------------------------------------------------------
// 1 + 2) LENHINT map
// ---------------------------------------------------------------------------

describe('LENHINT map', () => {
  it('has exactly 4 keys: 30, 60, 180, 300', () => {
    const keys = Object.keys(LENHINT).map(Number);
    expect(keys.sort((a, b) => a - b)).toEqual([30, 60, 180, 300]);
  });

  it('30s hint — exact string', () => {
    expect(LENHINT[30]).toBe('~5–6 beats · one sentence each · rapid cuts');
  });

  it('60s hint — exact string (the default)', () => {
    expect(LENHINT[60]).toBe('~7–9 beats · one sentence each · the classic short');
  });

  it('180s hint — exact string', () => {
    expect(LENHINT[180]).toBe('~22–30 beats · beats stretch to 2–3 sentences so cuts stay calm');
  });

  it('300s hint — exact string', () => {
    expect(LENHINT[300]).toBe('~38–48 beats · 2–3 sentence beats · verify caps scale up');
  });

  it('default target length is 60', () => {
    expect(DEFAULT_TARGET_LENGTH).toBe(60);
  });

  it('default length maps to the classic-short hint', () => {
    expect(LENHINT[DEFAULT_TARGET_LENGTH]).toBe(
      '~7–9 beats · one sentence each · the classic short',
    );
  });
});

// ---------------------------------------------------------------------------
// 3) handleStartSseEvent — Generate flow logic
// ---------------------------------------------------------------------------

function makeCallbacks(overrides: Partial<GenerateFlowCallbacks> = {}): GenerateFlowCallbacks {
  return {
    onSid: vi.fn(),
    onStage: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('handleStartSseEvent — sid event', () => {
  it('calls onSid with the sid and returns true (stop consuming)', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    const stop = handleStartSseEvent({type: 'sid', sid: 'abc-123'}, cbs, sidReceived);
    expect(cbs.onSid).toHaveBeenCalledWith('abc-123');
    expect(sidReceived.value).toBe(true);
    expect(stop).toBe(true);
  });

  it('does NOT call onError or onDone on a sid event', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    handleStartSseEvent({type: 'sid', sid: 'xyz'}, cbs, sidReceived);
    expect(cbs.onError).not.toHaveBeenCalled();
    expect(cbs.onDone).not.toHaveBeenCalled();
  });
});

describe('handleStartSseEvent — error event', () => {
  it('error-before-sid: calls onError with error field, returns true', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false}; // no sid yet
    const stop = handleStartSseEvent(
      {type: 'error', error: 'model overloaded'},
      cbs,
      sidReceived,
    );
    expect(cbs.onError).toHaveBeenCalledWith('model overloaded');
    expect(stop).toBe(true);
  });

  it('error-before-sid: falls back to message field when error field absent', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    handleStartSseEvent({type: 'error', message: 'timeout'}, cbs, sidReceived);
    expect(cbs.onError).toHaveBeenCalledWith('timeout');
  });

  it('error-before-sid: uses fallback string when both error+message absent', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    handleStartSseEvent({type: 'error'}, cbs, sidReceived);
    expect(cbs.onError).toHaveBeenCalledWith('Script generation failed');
  });

  it('error-AFTER-sid: onError is NOT called (sid already navigated)', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: true}; // sid already received
    handleStartSseEvent({type: 'error', error: 'late error'}, cbs, sidReceived);
    expect(cbs.onError).not.toHaveBeenCalled();
  });

  it('error-after-sid still returns true (stop consuming)', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: true};
    const stop = handleStartSseEvent({type: 'error', error: 'late'}, cbs, sidReceived);
    expect(stop).toBe(true);
  });
});

describe('handleStartSseEvent — stage event', () => {
  it('calls onStage and returns false (keep consuming)', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    const stop = handleStartSseEvent(
      {type: 'stage', stage: 'script', state: 'running'},
      cbs,
      sidReceived,
    );
    expect(cbs.onStage).toHaveBeenCalledWith('script', 'running', undefined);
    expect(stop).toBe(false);
  });

  it('passes elapsed_s through when present', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    handleStartSseEvent(
      {type: 'stage', stage: 'script', state: 'done', elapsed_s: 6.2},
      cbs,
      sidReceived,
    );
    expect(cbs.onStage).toHaveBeenCalledWith('script', 'done', 6.2);
  });

  it('does not call onSid, onError, onDone on stage events', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    handleStartSseEvent({type: 'stage', stage: 'voice', state: 'running'}, cbs, sidReceived);
    expect(cbs.onSid).not.toHaveBeenCalled();
    expect(cbs.onError).not.toHaveBeenCalled();
    expect(cbs.onDone).not.toHaveBeenCalled();
  });
});

describe('handleStartSseEvent — done event', () => {
  it('calls onDone and returns true when no prior sid', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    const stop = handleStartSseEvent({type: 'done'}, cbs, sidReceived);
    expect(cbs.onDone).toHaveBeenCalled();
    expect(stop).toBe(true);
  });
});

describe('handleStartSseEvent — unknown event', () => {
  it('ignores unknown type and returns false', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    const stop = handleStartSseEvent({type: 'progress'} as {type: string}, cbs, sidReceived);
    expect(cbs.onSid).not.toHaveBeenCalled();
    expect(cbs.onError).not.toHaveBeenCalled();
    expect(stop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4) Full flow simulation — sid arrives after a stage event
// ---------------------------------------------------------------------------

describe('handleStartSseEvent — realistic stream sequence', () => {
  it('stage → sid sequence: onStage then onSid, stops on sid', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};

    // First event: stage running
    let stop = handleStartSseEvent(
      {type: 'stage', stage: 'script', state: 'running'},
      cbs,
      sidReceived,
    );
    expect(stop).toBe(false);
    expect(cbs.onStage).toHaveBeenCalledOnce();
    expect(cbs.onSid).not.toHaveBeenCalled();

    // Second event: sid
    stop = handleStartSseEvent({type: 'sid', sid: 'sid-42'}, cbs, sidReceived);
    expect(stop).toBe(true);
    expect(cbs.onSid).toHaveBeenCalledWith('sid-42');
    expect(cbs.onError).not.toHaveBeenCalled();
  });

  it('error before any other event: onError called, stop=true', () => {
    const cbs = makeCallbacks();
    const sidReceived = {value: false};
    const stop = handleStartSseEvent(
      {type: 'error', error: 'DeepSeek timeout'},
      cbs,
      sidReceived,
    );
    expect(cbs.onError).toHaveBeenCalledWith('DeepSeek timeout');
    expect(stop).toBe(true);
    expect(cbs.onSid).not.toHaveBeenCalled();
  });
});
