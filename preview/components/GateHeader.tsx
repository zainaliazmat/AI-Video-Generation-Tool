'use client';

import Link from 'next/link';
import type {GatesDict} from '@/lib/studio';

// Floating glass toolbar for a gate (PRD §8): breadcrumb (‹ Hub / X), a status pill
// slot, the screen's single tinted action (optional), and a "Next: X →" chain so
// gates flow without hub round-trips.
//
// v3 M6 (T11):
//   - CHAIN updated: 'footage' → 'scenes' (ruling 3)
//   - The "Next →" link is gated: disabled (aria-disabled, dim) when the next gate
//     hasn't reached awaiting_approval/approved/reopened/stale yet.
//   - `gates` prop threads the GatesDict from the page so we can decide.

export const CHAIN = ['script', 'voice', 'scenes', 'assemble'] as const;
export type GateName = (typeof CHAIN)[number];

const LABEL: Record<GateName, string> = {script: 'Script', voice: 'Voice', scenes: 'Scenes', assemble: 'Assemble'};

/**
 * Pure helper: given the gates dict and the next gate name, return whether the
 * next-link should be enabled (i.e. the next gate has at least reached
 * awaiting_approval / approved / reopened / stale).
 *
 * When `gates` is undefined (legacy callers that don't pass it), the link is
 * always enabled (backward-compatible default).
 */
export function isNextLinkEnabled(nextGate: GateName, gates: GatesDict | undefined): boolean {
  if (!gates) return true;
  const row = gates[nextGate];
  if (!row) return false;
  return row.state === 'awaiting_approval' || row.state === 'approved' || row.state === 'reopened' || row.state === 'stale';
}

export function GateHeader({
  id,
  gate,
  status,
  action,
  gates,
}: {
  id: string;
  gate: GateName;
  status?: React.ReactNode;
  action?: React.ReactNode;
  /** v3: pass the GatesDict so the Next → link can be gated. When absent the
   *  link is always live (backward compatible with v2 pages that don't pass it). */
  gates?: GatesDict;
}) {
  const idx = CHAIN.indexOf(gate);
  const next: GateName | null = idx >= 0 && idx < CHAIN.length - 1 ? CHAIN[idx + 1] : null;
  const nextEnabled = next ? isNextLinkEnabled(next, gates) : false;

  return (
    <div className="glass mb-4 flex items-center gap-3 rounded-[var(--radius-xl)] px-3 py-2.5">
      <Link
        href={`/video/${id}`}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-accent-1 transition hover:bg-white/[0.1]"
        aria-label="Back to hub"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
      </Link>
      <span className="font-ui text-[13px] text-ink-muted">Hub /</span>
      <span className="font-ui text-[17px] font-semibold tracking-tight">{LABEL[gate]}</span>
      {status ? <span className="ml-1">{status}</span> : null}
      <span className="ml-auto flex items-center gap-2">
        {next ? (
          nextEnabled ? (
            <Link
              href={`/video/${id}/${next}`}
              className="rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
            >
              Next: {LABEL[next]} →
            </Link>
          ) : (
            <span
              aria-disabled="true"
              className="cursor-not-allowed rounded-full bg-white/[0.04] px-4 py-2 font-ui text-[13px] font-semibold text-ink-muted opacity-40 select-none"
              title={`${LABEL[next]} gate not yet reached`}
            >
              Next: {LABEL[next]} →
            </span>
          )
        ) : null}
        {action}
      </span>
    </div>
  );
}

/** The one tinted action per screen.
 *
 * variant="indigo" (default): the standard approve CTA — indigo fill, white text.
 * variant="amber": the Re-approve CTA shown when a gate is reopened / has stale
 *   downstream (ruling 16 / §4.1 design contract). Amber fill, near-black text for
 *   contrast (mirrors Button variant="warn" from ui.tsx).
 */
export function TintedButton({
  children,
  onClick,
  disabled,
  type = 'button',
  variant = 'indigo',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** 'indigo' = standard Approve CTA; 'amber' = Re-approve CTA (reopened gate). */
  variant?: 'indigo' | 'amber';
}) {
  const cls =
    variant === 'amber'
      ? 'rounded-full bg-warn px-5 py-2 font-ui text-[13px] font-semibold text-[#1a1308] shadow-[0_4px_16px_rgba(232,163,61,0.3)] transition hover:brightness-105 active:scale-[0.97] disabled:opacity-50'
      : 'rounded-full bg-accent-1 px-5 py-2 font-ui text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(94,92,230,0.4)] transition hover:brightness-110 disabled:opacity-50';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cls}
    >
      {children}
    </button>
  );
}
