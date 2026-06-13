// lib/gateCardState.ts
// Studio v3 M6 (T11) — pure helpers for the Hub page gate-card state derivation.
//
// Gate cards speak v3 states derived from /state.gates:
//   locked     — gate row absent/unreached
//   building   — gate is awaiting_approval with no prior approved_at (first build)
//   approved   — state === 'approved'
//   stale      — state === 'stale' (downstream of a reopen)
//   reopened   — state === 'reopened' OR (awaiting_approval with approved_at set = re-opened)
//
// The shape matches what GateName names in GateHeader.

import type {GatesDict} from '@/lib/studio';
import type {GateName} from '@/components/GateHeader';

export type CardState = 'locked' | 'building' | 'approved' | 'stale' | 'reopened';

/**
 * Derive the display state for a single gate card from the gates dict.
 *
 * Rules:
 *   - No row in gates dict → 'locked'
 *   - state === 'approved'              → 'approved'
 *   - state === 'stale'                 → 'stale'
 *   - state === 'reopened'              → 'reopened'
 *   - state === 'awaiting_approval' + approved_at is set → 'reopened'  (re-opened)
 *   - state === 'awaiting_approval' + no approved_at     → 'building'  (first build)
 */
export function deriveGateCardState(gate: GateName, gates: GatesDict): CardState {
  const row = gates[gate];
  if (!row) return 'locked';
  if (row.state === 'approved') return 'approved';
  if (row.state === 'stale') return 'stale';
  if (row.state === 'reopened') return 'reopened';
  // awaiting_approval: distinguish first-build vs re-open
  if (row.state === 'awaiting_approval') {
    if (row.approved_at) return 'reopened';
    return 'building';
  }
  // Unknown state — treat as locked
  return 'locked';
}

/**
 * Derive card states for all four gates at once.
 */
export function deriveAllCardStates(gates: GatesDict): Record<GateName, CardState> {
  return {
    script: deriveGateCardState('script', gates),
    voice: deriveGateCardState('voice', gates),
    scenes: deriveGateCardState('scenes', gates),
    assemble: deriveGateCardState('assemble', gates),
  };
}

/**
 * Return true when the "Rebuilt — Assemble is ready →" frontier toast should
 * fire: all gates prior to assemble are approved, and assemble is at
 * awaiting_approval (the frontier).
 *
 * Lighter version of ruling 4: we detect "all gates approved + assemble is
 * awaiting" rather than trying to detect a just-happened Re-approve.
 */
export function isAssembleFrontier(gates: GatesDict): boolean {
  const script = gates.script;
  const voice = gates.voice;
  const scenes = gates.scenes;
  const assemble = gates.assemble;
  if (!script || !voice || !scenes || !assemble) return false;
  return (
    script.state === 'approved' &&
    voice.state === 'approved' &&
    scenes.state === 'approved' &&
    assemble.state === 'awaiting_approval'
  );
}
