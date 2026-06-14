'use client';

// Studio v3 M6 — floating 4-gate stepper bar (F3a).
//
// This is DISTINCT from the existing PipelineStepper (5-stage linear indicator).
// GateStepper owns the v3 human-gate flow: Topic(✦) → 1 Script → 2 Voice →
// 3 Scenes → 4 Assemble.  Visual state is derived from the GatesDict + current
// prop each render — no local gate state (ruling OV-10: gate state is STORED not
// derived from stage staleness, but the per-step visual class IS derived from
// the stored gate rows here in the UI layer).
//
// Breakpoint: below sm labels hide (icons only), matching the mock's
// `#bar { gap:8px } .stp { padding:7px 8px } .stp span.lbl { display:none }`
// and `#autorun span.lbl { display:none }` rule.

import {useCallback, useRef} from 'react';
import Link from 'next/link';
import {cn} from '@/lib/cn';
import type {GatesDict} from '@/lib/studio';

// ─── types ────────────────────────────────────────────────────────────────────

type GateKey = 'script' | 'voice' | 'scenes' | 'assemble';

export interface GateStepperProps {
  gates: GatesDict;
  current: GateKey;
  autoRun: boolean;
  onToggleAutoRun: (b: boolean) => void;
  onNavigate: (gate: GateKey) => void;
}

// ─── derived step state ───────────────────────────────────────────────────────

/**
 * Per-step visual state used by GateStepper.  Derived from gates + current.
 *
 * - 'done'     → gate is approved AND before the current step (green ✓, navigable)
 * - 'current'  → the active gate (tinted pip, subtle bg)
 * - 'stale'    → gate state === 'stale' (amber stale-dot on pip)
 * - 'reopened' → awaiting_approval WITH approved_at set (current-like + reopened affordance)
 * - 'pending'  → gate row absent or after current in the order (dim, aria-disabled)
 */
export type StepVisualState = 'done' | 'current' | 'stale' | 'reopened' | 'pending';

/** The ordered steps in the stepper. Topic is a special non-gate "home" step. */
const GATE_ORDER: GateKey[] = ['script', 'voice', 'scenes', 'assemble'];
const GATE_NUM: Record<GateKey, string> = {
  script: '1',
  voice: '2',
  scenes: '3',
  assemble: '4',
};
const GATE_LABEL: Record<GateKey, string> = {
  script: 'Script',
  voice: 'Voice',
  scenes: 'Scenes',
  assemble: 'Assemble',
};

export function deriveStepVisualState(
  gateKey: GateKey,
  gates: GatesDict,
  current: GateKey,
): StepVisualState {
  const currentIdx = GATE_ORDER.indexOf(current);
  const stepIdx = GATE_ORDER.indexOf(gateKey);
  const gateRow = gates[gateKey];

  if (gateKey === current) {
    // Check if this is a reopened gate: awaiting_approval + has approved_at
    if (gateRow && gateRow.state === 'awaiting_approval' && gateRow.approved_at) {
      return 'reopened';
    }
    return 'current';
  }

  if (gateRow) {
    if (gateRow.state === 'stale') return 'stale';
    if (gateRow.state === 'approved' && stepIdx < currentIdx) return 'done';
    // awaiting_approval on a non-current step: treat as current-like but
    // the step is not "current" per the prop — treat as pending (not navigable
    // unless it has been approved at least once, which doesn't apply here)
    if (gateRow.state === 'awaiting_approval') {
      // If it has an approved_at and is before current it was reopened but we
      // navigated away — treat as stale for visual purposes
      if (gateRow.approved_at && stepIdx < currentIdx) return 'stale';
      return 'pending';
    }
  }

  // No gate row yet, or gate is after current in order
  return 'pending';
}

// ─── component ────────────────────────────────────────────────────────────────

export function GateStepper({
  gates,
  current,
  autoRun,
  onToggleAutoRun,
  onNavigate,
}: GateStepperProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation within the stepper (arrow keys move focus between steps)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>, gateKey: GateKey, isNavigable: boolean) => {
      const idx = GATE_ORDER.indexOf(gateKey);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = Math.min(idx + 1, GATE_ORDER.length - 1);
        const nextBtn = containerRef.current?.querySelector<HTMLButtonElement>(
          `[data-gate="${GATE_ORDER[nextIdx]}"]`,
        );
        nextBtn?.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = Math.max(idx - 1, 0);
        const prevBtn = containerRef.current?.querySelector<HTMLButtonElement>(
          `[data-gate="${GATE_ORDER[prevIdx]}"]`,
        );
        prevBtn?.focus();
      } else if ((e.key === 'Enter' || e.key === ' ') && isNavigable) {
        e.preventDefault();
        onNavigate(gateKey);
      }
    },
    [onNavigate],
  );

  const handleAutoRunKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onToggleAutoRun(!autoRun);
      }
    },
    [autoRun, onToggleAutoRun],
  );

  return (
    <nav
      ref={containerRef}
      className={cn(
        'glass fixed left-1/2 top-3 z-40 -translate-x-1/2',
        'flex h-[54px] max-w-[min(1180px,calc(100vw-24px))] items-center gap-3.5',
        'rounded-[27px] px-3.5 pl-4',
      )}
      aria-label="Studio gate stepper"
    >
      {/* Brand mark */}
      <span className="flex items-center gap-2 whitespace-nowrap font-ui text-[13.5px] font-bold tracking-[-0.01em]">
        <span
          className="h-3.5 w-3.5 rounded-[5px] bg-gradient-to-br from-accent-1 to-[#22d3ee]"
          style={{boxShadow: '0 0 12px rgba(94,92,230,0.6)'}}
          aria-hidden="true"
        />
        Studio
      </span>

      {/* Gate steps */}
      <div className="flex items-center gap-0.5" role="list">
        {/* Topic — non-gate home step. Links Home (the global Nav is hidden on
            /video routes, so this is the route back to the topic screen). */}
        <Link
          href="/"
          className="flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-[7px] font-ui text-[12.5px] font-semibold text-ink-muted transition-colors duration-[250ms] hover:bg-white/[0.08] hover:text-ink-secondary"
          role="listitem"
          aria-label="Topic — back to home"
        >
          <span
            className={cn(
              'inline-flex h-[18px] w-[18px] items-center justify-center rounded-full',
              'bg-white/[0.08] font-mono text-[10px] font-semibold text-ink-muted',
            )}
            aria-hidden="true"
          >
            ✦
          </span>
          <span className="lbl sm:inline hidden">Topic</span>
        </Link>

        <span className="px-[1px] text-[11px] text-ink-muted opacity-50" aria-hidden="true">›</span>

        {GATE_ORDER.map((gateKey, idx) => {
          const vs = deriveStepVisualState(gateKey, gates, current);
          const isNavigable = vs === 'done';
          const isDisabled = vs === 'pending';
          const isStale = vs === 'stale';
          const isCurrent = vs === 'current' || vs === 'reopened';
          const isReopened = vs === 'reopened';

          return (
            <span key={gateKey} className="flex items-center" role="listitem">
              <button
                type="button"
                data-gate={gateKey}
                aria-current={isCurrent ? 'step' : undefined}
                aria-disabled={isDisabled ? true : undefined}
                aria-label={`${GATE_LABEL[gateKey]}${isReopened ? ' — reopened' : ''}${isStale ? ' — stale' : ''}`}
                onClick={isNavigable ? () => onNavigate(gateKey) : undefined}
                onKeyDown={(e) => handleKeyDown(e, gateKey, isNavigable)}
                tabIndex={isDisabled ? -1 : 0}
                className={cn(
                  'flex items-center gap-[7px] rounded-full border-0 px-3 py-[7px]',
                  'whitespace-nowrap font-ui text-[12.5px] font-semibold',
                  'transition-[color,background] duration-[250ms]',
                  // done: navigable
                  isNavigable && 'cursor-pointer text-ink-secondary hover:bg-white/[0.08]',
                  // current / reopened: solid tinted bg
                  isCurrent && 'bg-white/[0.13] text-ink',
                  // stale: dim but amber signal
                  isStale && 'cursor-default text-ink-secondary',
                  // pending: dim, not interactive
                  isDisabled && 'cursor-default text-ink-muted',
                )}
              >
                {/* Pip icon */}
                <span
                  className={cn(
                    'relative inline-flex h-[18px] w-[18px] flex-none items-center justify-center',
                    'rounded-full font-mono text-[10px] font-semibold',
                    'transition-all duration-[250ms]',
                    // done → green pip
                    isNavigable && 'bg-[rgba(48,209,88,0.16)] text-[#30d158]',
                    // current/reopened → tinted solid pip
                    isCurrent &&
                      'bg-accent-1 text-white shadow-[0_0_10px_rgba(94,92,230,0.55)]',
                    // stale → amber but no glow on the pip itself (the stale-dot carries the glow)
                    isStale && 'bg-white/[0.08] text-ink-muted',
                    // pending → dim
                    isDisabled && 'bg-white/[0.06] text-ink-muted',
                  )}
                  aria-hidden="true"
                >
                  {/* Green check for done; number otherwise */}
                  {isNavigable ? '✓' : GATE_NUM[gateKey]}

                  {/* Stale-dot: amber glow on the pip when gate is stale (F1 .stale-dot class) */}
                  {isStale && (
                    <span
                      className="stale-dot absolute -right-[3px] -top-[3px]"
                      aria-hidden="true"
                    />
                  )}
                </span>

                {/* Label — hidden on narrow screens */}
                <span className="lbl hidden sm:inline">{GATE_LABEL[gateKey]}</span>

                {/* Reopened affordance */}
                {isReopened && (
                  <span className="hidden text-[10px] font-medium text-warn sm:inline">
                    · reopened
                  </span>
                )}
              </button>

              {/* Separator arrow between steps (not after last) */}
              {idx < GATE_ORDER.length - 1 && (
                <span
                  className="px-[1px] text-[11px] text-ink-muted opacity-50"
                  aria-hidden="true"
                >
                  ›
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* Auto-run toggle (PRD §4: "Auto-run" switch — approve everything with defaults) */}
      <div
        role="switch"
        aria-checked={autoRun}
        aria-label="Auto-run"
        tabIndex={0}
        onClick={() => onToggleAutoRun(!autoRun)}
        onKeyDown={handleAutoRunKeyDown}
        className={cn(
          'ml-1 flex cursor-pointer select-none items-center gap-2',
          'whitespace-nowrap font-ui text-[11.5px] font-semibold text-ink-muted',
          'transition-colors duration-[250ms]',
          autoRun && 'text-ink',
        )}
      >
        {/* Toggle pill */}
        <span
          className={cn(
            'relative h-[18px] w-[30px] flex-none rounded-full transition-colors duration-[250ms]',
            autoRun ? 'bg-accent-1' : 'bg-white/[0.14]',
          )}
          aria-hidden="true"
        >
          <span
            className={cn(
              'absolute top-[2.5px] h-[13px] w-[13px] rounded-full bg-white opacity-85',
              'transition-transform duration-[250ms]',
              autoRun ? 'left-[3px] translate-x-[11px]' : 'left-[3px]',
            )}
          />
        </span>
        <span className="lbl hidden sm:inline">Auto-run</span>
      </div>
    </nav>
  );
}
