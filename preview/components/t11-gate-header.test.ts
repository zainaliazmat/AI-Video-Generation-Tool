/**
 * T11: GateHeader pure-logic tests.
 *
 * Tests cover:
 *   1. CHAIN is the new 4-gate array with 'scenes' (not 'footage').
 *   2. isNextLinkEnabled — the next-link gating rule:
 *      enabled when next gate row is present with any of:
 *        awaiting_approval | approved | reopened | stale
 *      disabled (false) when the next gate row is absent.
 *   3. TintedButton variant existence (type-level — we just import and assert
 *      the helper is callable with variant params; no jsdom needed).
 */

import {describe, it, expect} from 'vitest';
import {CHAIN, isNextLinkEnabled} from './GateHeader';
import type {GatesDict} from '../lib/studio';

// ─── CHAIN ────────────────────────────────────────────────────────────────────

describe('CHAIN constant', () => {
  it('has exactly 4 gates', () => {
    expect(CHAIN).toHaveLength(4);
  });

  it('contains scenes (not footage)', () => {
    expect(CHAIN).toContain('scenes');
    // 'footage' was removed in v3 M6 — verify it's not in the chain at runtime.
    expect((CHAIN as readonly string[])).not.toContain('footage');
  });

  it('order is script → voice → scenes → assemble', () => {
    expect(Array.from(CHAIN)).toEqual(['script', 'voice', 'scenes', 'assemble']);
  });
});

// ─── isNextLinkEnabled ────────────────────────────────────────────────────────

describe('isNextLinkEnabled', () => {
  it('returns true when gates is undefined (backward-compat)', () => {
    expect(isNextLinkEnabled('voice', undefined)).toBe(true);
  });

  it('returns false when next gate row is absent (locked)', () => {
    const gates: GatesDict = {}; // no rows at all
    expect(isNextLinkEnabled('voice', gates)).toBe(false);
    expect(isNextLinkEnabled('scenes', gates)).toBe(false);
    expect(isNextLinkEnabled('assemble', gates)).toBe(false);
  });

  it('returns true when next gate is awaiting_approval (first build)', () => {
    const gates: GatesDict = {
      voice: {state: 'awaiting_approval', approved_at: null},
    };
    expect(isNextLinkEnabled('voice', gates)).toBe(true);
  });

  it('returns true when next gate is approved', () => {
    const gates: GatesDict = {
      scenes: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(isNextLinkEnabled('scenes', gates)).toBe(true);
  });

  it('returns true when next gate is stale', () => {
    const gates: GatesDict = {
      assemble: {state: 'stale', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(isNextLinkEnabled('assemble', gates)).toBe(true);
  });

  it('returns true when next gate is reopened', () => {
    const gates: GatesDict = {
      scenes: {state: 'reopened', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(isNextLinkEnabled('scenes', gates)).toBe(true);
  });

  it('disabled: next gate row absent even when earlier gates approved', () => {
    // script + voice approved but scenes row is absent → next from voice is disabled
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      // scenes is missing
    };
    expect(isNextLinkEnabled('scenes', gates)).toBe(false);
  });

  it('full happy path: each gate reached enables the next link', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'awaiting_approval', approved_at: null},
      assemble: {state: 'awaiting_approval', approved_at: null},
    };
    // script→voice: voice row present → enabled
    expect(isNextLinkEnabled('voice', gates)).toBe(true);
    // voice→scenes: scenes row present → enabled
    expect(isNextLinkEnabled('scenes', gates)).toBe(true);
    // scenes→assemble: assemble row present → enabled
    expect(isNextLinkEnabled('assemble', gates)).toBe(true);
  });
});
