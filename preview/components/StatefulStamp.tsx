'use client';

// Studio v3 M6 — per-gate stamp line (F3a).
//
// The stamp renders below a gate header as a mono line with a leading green dot.
// Copy is faithful to the mock §Stamps.  Dynamic parts (counts, version) arrive
// as props so gate pages can fill them in.
//
// Visual:  ● <copy>
// The dot is green when approved, amber when awaiting_approval or stale.
//
// Exact mock copy per gate / state:
//   script   pre:      "script ready in {elapsedS} s · grounded · verified {ok}/{total}"
//            approved: "approved · downstream builds from v1 · editing reopens this gate"
//            reopened: "reopened · re-approve to rebuild downstream"
//   voice    approved: "previews ready · script v1 locked"
//   scenes   approved: "{sceneCount} scenes · {totalCount} total · pools fetched {poolsPerScene}/scene"
//   assemble approved: "spec.json v{version} · pydantic ✓ · templates ✓"

import {cn} from '@/lib/cn';
import type {Gate} from '@/lib/studio';

// ─── types ────────────────────────────────────────────────────────────────────

type GateKey = 'script' | 'voice' | 'scenes' | 'assemble';

export interface StatefulStampProps {
  gate: GateKey;
  gateState: Gate | undefined;
  /** Extra content rendered after the stamp line (e.g. a reopen preview button). */
  content?: React.ReactNode;

  // Dynamic values for each gate's copy
  /** script gate: elapsed seconds for "ready in X s" copy (pre-approval). */
  elapsedS?: number | null;
  /** script gate: verified count for "verified N/M" copy. */
  verifiedOk?: number;
  /** script gate: total beats for "verified N/M" copy. */
  verifiedTotal?: number;
  /** scenes gate: number of footage scenes. */
  sceneCount?: number;
  /** scenes gate: total scene count across all templates. */
  totalCount?: number;
  /** scenes gate: candidate pool size per scene. */
  poolsPerScene?: number;
  /** assemble gate: spec version number. */
  specVersion?: number;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isApproved(g: Gate | undefined): boolean {
  return g?.state === 'approved';
}

function isReopened(g: Gate | undefined): boolean {
  // awaiting_approval WITH approved_at set = reopened gate (§4.1)
  return g?.state === 'awaiting_approval' && g.approved_at != null;
}

// ─── per-gate copy derivation (exported for tests) ───────────────────────────

export interface StampCopy {
  text: string;
  dotTone: 'green' | 'amber';
}

export function deriveStampCopy(
  gate: GateKey,
  gateState: Gate | undefined,
  opts: {
    elapsedS?: number | null;
    verifiedOk?: number;
    verifiedTotal?: number;
    sceneCount?: number;
    totalCount?: number;
    poolsPerScene?: number;
    specVersion?: number;
  } = {},
): StampCopy {
  const approved = isApproved(gateState);
  const reopened = isReopened(gateState);

  switch (gate) {
    case 'script': {
      if (reopened) {
        return {
          text: 'reopened · re-approve to rebuild downstream',
          dotTone: 'amber',
        };
      }
      if (approved) {
        return {
          text: 'approved · downstream builds from v1 · editing reopens this gate',
          dotTone: 'green',
        };
      }
      // Pre-approval: show timing + grounding + verify stats if available
      const parts: string[] = [];
      if (opts.elapsedS != null) {
        parts.push(`script ready in ${opts.elapsedS} s`);
      } else {
        parts.push('script ready');
      }
      parts.push('grounded');
      if (opts.verifiedOk != null && opts.verifiedTotal != null) {
        parts.push(`verified ${opts.verifiedOk}/${opts.verifiedTotal}`);
      }
      return {text: parts.join(' · '), dotTone: 'green'};
    }

    case 'voice': {
      if (approved) {
        return {text: 'previews ready · script v1 locked', dotTone: 'green'};
      }
      // Pre-approval: neutral
      return {text: 'voice preview ready · script v1 locked', dotTone: 'amber'};
    }

    case 'scenes': {
      if (approved) {
        const sc = opts.sceneCount ?? 0;
        const tot = opts.totalCount ?? 0;
        const pps = opts.poolsPerScene ?? 15;
        return {
          text: `${sc} scenes · ${tot} total · pools fetched ${pps}/scene`,
          dotTone: 'green',
        };
      }
      return {
        text: 'scenes ready · footage pools fetched',
        dotTone: 'amber',
      };
    }

    case 'assemble': {
      if (approved || gateState?.state === 'awaiting_approval') {
        const v = opts.specVersion ?? 1;
        return {
          text: `spec.json v${v} · pydantic ✓ · templates ✓`,
          dotTone: 'green',
        };
      }
      return {text: 'spec pending', dotTone: 'amber'};
    }
  }
}

// ─── component ────────────────────────────────────────────────────────────────

export function StatefulStamp({
  gate,
  gateState,
  content,
  elapsedS,
  verifiedOk,
  verifiedTotal,
  sceneCount,
  totalCount,
  poolsPerScene,
  specVersion,
}: StatefulStampProps) {
  const {text, dotTone} = deriveStampCopy(gate, gateState, {
    elapsedS,
    verifiedOk,
    verifiedTotal,
    sceneCount,
    totalCount,
    poolsPerScene,
    specVersion,
  });

  return (
    <div className="mt-[9px] flex flex-col gap-1">
      <span className="inline-flex items-center gap-[6px] font-mono text-[11px] font-medium text-ink-muted">
        {/* Leading dot */}
        <span
          className={cn(
            'h-1.5 w-1.5 flex-none rounded-full',
            dotTone === 'green' ? 'bg-[#30d158]' : 'bg-warn',
          )}
          aria-hidden="true"
        />
        {text}
      </span>
      {content}
    </div>
  );
}
