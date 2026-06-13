'use client';

import {cn} from '@/lib/cn';

/** Small uppercase eyebrow label (spec §10.3 label/eyebrow). */
export function Eyebrow({children, className}: {children: React.ReactNode; className?: string}) {
  return (
    <div
      className={cn(
        'font-ui text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted',
        className,
      )}
    >
      {children}
    </div>
  );
}

type BadgeTone = 'green' | 'amber' | 'red' | 'purple' | 'blue' | 'dim';

const BADGE_TONES: Record<BadgeTone, string> = {
  green: 'bg-[rgba(16,185,129,0.15)] text-[#34d399]',
  amber: 'bg-[rgba(245,158,11,0.15)] text-[#fbbf24]',
  red: 'bg-[rgba(239,68,68,0.15)] text-[#f87171]',
  purple: 'bg-[rgba(139,92,246,0.15)] text-[#a78bfa]',
  blue: 'bg-[rgba(59,130,246,0.15)] text-[#60a5fa]',
  dim: 'bg-white/[0.05] text-ink-muted',
};

/** Pill badge (spec §10.7). */
export function Badge({
  tone = 'dim',
  children,
  dot,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] font-ui text-[11px] font-semibold tracking-[0.04em]',
        BADGE_TONES[tone],
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Horizontal progress bar — never circular (spec §10.7). */
export function ProgressBar({value}: {value: number}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div className="flex items-center gap-3">
      <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-grad-main transition-[width] duration-200 ease-out"
          style={{width: `${pct * 100}%`}}
        />
      </div>
      <span className="font-mono text-[12px] tabular-nums text-ink-secondary">
        {Math.round(pct * 100)}%
      </span>
    </div>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'warn';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-grad-main text-white shadow-[0_4px_20px_rgba(99,102,241,0.35)] hover:-translate-y-px hover:shadow-[0_6px_28px_rgba(99,102,241,0.5)]',
  ghost: 'glass glass-hover text-ink',
  danger:
    'bg-[rgba(239,68,68,0.10)] border border-[rgba(239,68,68,0.25)] text-[#f87171] hover:bg-[rgba(239,68,68,0.16)]',
  // M6 amber Re-approve/Reopen CTA (§4.1 design contract ruling 16).
  // Amber fill, near-black text for contrast, weight 600 per spec.
  // hover: slightly brighter fill; active: scale-down micro-tap feedback.
  warn: 'bg-warn text-[#1a1308] font-semibold shadow-[0_4px_16px_rgba(232,163,61,0.3)] hover:-translate-y-px hover:shadow-[0_6px_24px_rgba(232,163,61,0.45)] hover:bg-[#f0b24d] active:scale-[0.97] active:shadow-none',
};

/** Button (spec §10.7): radius 8px, 13.5px, weight 500, 150ms ease-out. */
export function Button({
  variant = 'primary',
  className,
  ...props
}: {variant?: ButtonVariant} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[8px] px-4 py-2.5 font-ui text-[13.5px] font-medium',
        'transition-all duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none',
        BUTTON_VARIANTS[variant],
        className,
      )}
    />
  );
}
