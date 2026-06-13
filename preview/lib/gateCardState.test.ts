/**
 * T11: Hub gate-card state derivation tests.
 *
 * Tests cover:
 *   1. deriveGateCardState — per-gate fixture coverage across all 5 CardStates.
 *   2. deriveAllCardStates — multi-gate fixture.
 *   3. isAssembleFrontier — frontier toast condition.
 */

import {describe, it, expect} from 'vitest';
import {deriveGateCardState, deriveAllCardStates, isAssembleFrontier} from './gateCardState';
import type {GatesDict} from './studio';

// ─── deriveGateCardState ──────────────────────────────────────────────────────

describe('deriveGateCardState', () => {
  it('locked — gate row absent', () => {
    const gates: GatesDict = {};
    expect(deriveGateCardState('script', gates)).toBe('locked');
    expect(deriveGateCardState('voice', gates)).toBe('locked');
    expect(deriveGateCardState('scenes', gates)).toBe('locked');
    expect(deriveGateCardState('assemble', gates)).toBe('locked');
  });

  it('building — awaiting_approval with no approved_at (first build)', () => {
    const gates: GatesDict = {
      script: {state: 'awaiting_approval', approved_at: null},
    };
    expect(deriveGateCardState('script', gates)).toBe('building');
  });

  it('approved — state is approved', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(deriveGateCardState('script', gates)).toBe('approved');
  });

  it('stale — state is stale', () => {
    const gates: GatesDict = {
      voice: {state: 'stale', approved_at: '2026-06-13T00:01:00Z'},
    };
    expect(deriveGateCardState('voice', gates)).toBe('stale');
  });

  it('reopened — state is reopened', () => {
    const gates: GatesDict = {
      script: {state: 'reopened', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(deriveGateCardState('script', gates)).toBe('reopened');
  });

  it('reopened — awaiting_approval WITH approved_at (re-edit after prior approval)', () => {
    const gates: GatesDict = {
      script: {state: 'awaiting_approval', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(deriveGateCardState('script', gates)).toBe('reopened');
  });

  it('locked — partial gates dict: only script present, others absent', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(deriveGateCardState('voice', gates)).toBe('locked');
    expect(deriveGateCardState('scenes', gates)).toBe('locked');
    expect(deriveGateCardState('assemble', gates)).toBe('locked');
  });
});

// ─── deriveAllCardStates ──────────────────────────────────────────────────────

describe('deriveAllCardStates', () => {
  it('full happy path: script done → voice done → scenes current → assemble locked', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'awaiting_approval', approved_at: null},
      // assemble absent
    };
    const result = deriveAllCardStates(gates);
    expect(result.script).toBe('approved');
    expect(result.voice).toBe('approved');
    expect(result.scenes).toBe('building');
    expect(result.assemble).toBe('locked');
  });

  it('stale + reopened mix', () => {
    const gates: GatesDict = {
      script: {state: 'awaiting_approval', approved_at: '2026-06-13T00:00:00Z'}, // reopened
      voice: {state: 'stale', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'stale', approved_at: '2026-06-13T00:02:00Z'},
    };
    const result = deriveAllCardStates(gates);
    expect(result.script).toBe('reopened');
    expect(result.voice).toBe('stale');
    expect(result.scenes).toBe('stale');
    expect(result.assemble).toBe('locked');
  });

  it('empty gates: all locked', () => {
    const result = deriveAllCardStates({});
    expect(result.script).toBe('locked');
    expect(result.voice).toBe('locked');
    expect(result.scenes).toBe('locked');
    expect(result.assemble).toBe('locked');
  });
});

// ─── isAssembleFrontier ───────────────────────────────────────────────────────

describe('isAssembleFrontier', () => {
  it('true — all prior approved + assemble awaiting_approval', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'approved', approved_at: '2026-06-13T00:02:00Z'},
      assemble: {state: 'awaiting_approval', approved_at: null},
    };
    expect(isAssembleFrontier(gates)).toBe(true);
  });

  it('false — assemble not present yet', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'approved', approved_at: '2026-06-13T00:02:00Z'},
      // assemble absent
    };
    expect(isAssembleFrontier(gates)).toBe(false);
  });

  it('false — assemble already approved (frontier already passed)', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'approved', approved_at: '2026-06-13T00:02:00Z'},
      assemble: {state: 'approved', approved_at: '2026-06-13T00:03:00Z'},
    };
    expect(isAssembleFrontier(gates)).toBe(false);
  });

  it('false — prior gate is stale (not approved)', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'stale', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'approved', approved_at: '2026-06-13T00:02:00Z'},
      assemble: {state: 'awaiting_approval', approved_at: null},
    };
    expect(isAssembleFrontier(gates)).toBe(false);
  });

  it('false — empty gates', () => {
    expect(isAssembleFrontier({})).toBe(false);
  });
});
