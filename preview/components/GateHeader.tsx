'use client';

import Link from 'next/link';

// Floating glass toolbar for a gate (PRD §8): breadcrumb (‹ Hub / X), a status pill
// slot, the screen's single tinted action (optional), and a "Next: X →" chain so
// gates flow without hub round-trips.
const CHAIN = ['script', 'voice', 'footage', 'assemble'] as const;
const LABEL: Record<string, string> = {script: 'Script', voice: 'Voice', footage: 'Footage', assemble: 'Assemble'};

export function GateHeader({
  id,
  gate,
  status,
  action,
}: {
  id: string;
  gate: (typeof CHAIN)[number];
  status?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const idx = CHAIN.indexOf(gate);
  const next = idx >= 0 && idx < CHAIN.length - 1 ? CHAIN[idx + 1] : null;
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
          <Link
            href={`/video/${id}/${next}`}
            className="rounded-full bg-white/[0.07] px-4 py-2 font-ui text-[13px] font-semibold text-ink transition hover:bg-white/[0.12]"
          >
            Next: {LABEL[next]} →
          </Link>
        ) : null}
        {action}
      </span>
    </div>
  );
}

/** The one tinted (indigo) action per screen. */
export function TintedButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-full bg-accent-1 px-5 py-2 font-ui text-[13px] font-semibold text-white shadow-[0_6px_18px_rgba(94,92,230,0.4)] transition hover:brightness-110 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
