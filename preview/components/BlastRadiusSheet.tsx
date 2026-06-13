'use client';

// Studio v3 M6 — BlastRadiusSheet (F3b).
//
// §4.1 first-edit-intent sheet (APPROVED hybrid B+C):
//   B  — task chips (same vocabulary as the interstitial, §4.1 traceability)
//   C  — pin-fate table, rendered ONLY when pins are at stake (conditional)
//   A  — per-stage time estimates as chip subtext
//
// Amber is ONLY via:
//   • chip dots (leading amber dot, --warn)
//   • pin-fate lost-row text (text-warn)
//   • 3px top hairline on the glass panel
//   • the Reopen button (Button variant="warn")
// No amber border strips.
//
// A11y/responsive:
//   • ≥sm: centered glass dialog (fixed overlay)
//   • <sm: bottom sheet (fixed bottom-0, rounded-t-2xl)
//   • focus trap with INITIAL FOCUS on Cancel (the amber action is costly)
//   • ESC = Cancel
//   • role="dialog" aria-modal
//   • ghost/dim page behind (pointer-events:none backdrop)
//   • all hit targets ≥ 44px

import {useEffect, useRef} from 'react';
import {cn} from '@/lib/cn';
import type {ReopenPreview} from '@/lib/studio';
import {studio} from '@/lib/studio';
import {Button} from '@/components/ui';
import {useCallback, useState} from 'react';

// ─── types ────────────────────────────────────────────────────────────────────

export interface BlastRadiusSheetProps {
  open: boolean;
  gate: string;
  sid: string;
  /** Commit: caller then applies the withheld edit + flips gate action to amber Re-approve. */
  onReopen: () => void;
  /** Discards local edit, ZERO backend traffic. */
  onCancel: () => void;
}

// ─── pin-fate derivation (exported for tests) ─────────────────────────────────

export interface PinFateRow {
  label: string; // e.g. "Scene 2 · pinned clip"
  survives: boolean;
}

/**
 * Derives pin-fate rows from a ReopenPreview response.
 *
 * The ReopenPreview type from studio.ts carries `reruns` and `staleGates` but
 * NOT pin detail (the Python backend does not yet emit it).  The sheet spec
 * says: render the table ONLY when pins are at stake.  We check
 * `preview.pinFates` (an optional extension that a future backend may attach)
 * and fall back gracefully to `undefined` (no table) when absent.
 *
 * The `pinFates` field is typed loosely here to allow future extension without
 * a breaking type change.
 */
export function derivePinFates(
  preview: ReopenPreview & {pinFates?: PinFateRow[]},
): PinFateRow[] | null {
  // If the backend attaches pinFates, use them.
  if (preview.pinFates && preview.pinFates.length > 0) {
    return preview.pinFates;
  }
  return null;
}

// ─── stage label + time-estimate map ─────────────────────────────────────────

// Interstitial vocabulary (spec: "voiceover/word-timing/footage pools/spec")
// plus rough time estimates matching the wireframe §A ledger rows.
const STAGE_META: Record<string, {label: string; estimate: string}> = {
  'voiceover': {label: 'voiceover', estimate: '~20 s'},
  'voice': {label: 'voiceover', estimate: '~20 s'},
  'timing': {label: 'word-timing', estimate: '~15 s'},
  'word-timing': {label: 'word-timing', estimate: '~15 s'},
  'footage': {label: 'footage pools', estimate: '~10 s'},
  'footage pools': {label: 'footage pools', estimate: '~10 s'},
  'spec': {label: 'spec', estimate: '<1 s'},
  'assemble': {label: 'spec', estimate: '<1 s'},
  'script': {label: 'script', estimate: '~25 s'},
};

function getStageMeta(stage: string): {label: string; estimate: string} {
  return STAGE_META[stage.toLowerCase()] ?? {label: stage, estimate: ''};
}

/** Human-readable gate name. */
function gateDisplayName(gate: string): string {
  const map: Record<string, string> = {
    script: 'Script',
    voice: 'Voice',
    scenes: 'Scenes',
    assemble: 'Assemble',
  };
  return map[gate.toLowerCase()] ?? gate.charAt(0).toUpperCase() + gate.slice(1);
}

// ─── component ────────────────────────────────────────────────────────────────

export function BlastRadiusSheet({
  open,
  gate,
  sid,
  onReopen,
  onCancel,
}: BlastRadiusSheetProps) {
  const [preview, setPreview] = useState<(ReopenPreview & {pinFates?: PinFateRow[]}) | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Refs for focus management
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const gateName = gateDisplayName(gate);

  // ── fetch preview-reopen on open ─────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setFetchError(null);
    setPreview(null);

    studio.session
      .previewReopen(sid, gate)
      .then((p) => {
        setPreview(p as ReopenPreview & {pinFates?: PinFateRow[]});
        setLoading(false);
      })
      .catch((err: unknown) => {
        setFetchError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [open, sid, gate]);

  // ── focus initial focus on Cancel ────────────────────────────────────────

  useEffect(() => {
    if (open) {
      // Defer to next tick so the element is painted
      const id = setTimeout(() => {
        cancelBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  // ── ESC = Cancel ─────────────────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [onCancel],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleKeyDown]);

  // ── focus trap ───────────────────────────────────────────────────────────

  const handleFocusTrapKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Tab') return;
      if (!dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [],
  );

  // ── derived chip + pin data ──────────────────────────────────────────────

  const pinFates = preview ? derivePinFates(preview) : null;
  const hasPins = pinFates !== null && pinFates.length > 0;

  // ── render ───────────────────────────────────────────────────────────────

  if (!open) return null;

  return (
    <>
      {/* Backdrop — dims the page, pointer-events: none so it doesn't steal clicks
          (the dialog handles all interaction via focus trap) */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
        style={{pointerEvents: 'none'}}
        aria-hidden="true"
      />

      {/* Centering container — click outside = cancel (pointer-events: auto) */}
      <div
        className={cn(
          'fixed inset-0 z-50 flex',
          // ≥sm: centered dialog; <sm: bottom-sheet
          'items-end sm:items-center',
          'justify-center',
        )}
        onClick={(e) => {
          // Only cancel if clicking the backdrop layer directly (not the dialog)
          if (e.target === e.currentTarget) onCancel();
        }}
      >
        {/* Dialog panel */}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="blast-radius-title"
          onKeyDown={handleFocusTrapKeyDown}
          className={cn(
            // Glass surface
            'glass relative w-full sm:w-[480px] sm:max-w-[calc(100vw-32px)]',
            // Bottom sheet on mobile
            'rounded-t-[20px] sm:rounded-[16px]',
            // 3px amber top hairline — the ONLY amber border element
            'border-t-[3px] border-t-warn sm:border-t-[3px]',
            // Padding
            'px-6 pb-6 pt-[22px]',
          )}
        >
          {/* Title */}
          <h2
            id="blast-radius-title"
            className="mb-1 font-ui text-[17px] font-semibold text-ink"
          >
            Reopen {gateName}?
          </h2>

          {/* Subtitle */}
          <p className="mb-[14px] font-ui text-[12.5px] text-ink-muted">
            These tasks run again on Re-approve — the same card you saw between gates:
          </p>

          {/* Loading / error state */}
          {loading && (
            <p className="mb-3 font-mono text-[12px] text-ink-muted">Loading…</p>
          )}
          {fetchError && (
            <p className="mb-3 font-mono text-[12px] text-[#f87171]">{fetchError}</p>
          )}

          {/* Task chips (hybrid B: same vocabulary as the interstitial) */}
          {preview && preview.reruns.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {preview.reruns.map((stage) => {
                const meta = getStageMeta(stage);
                return (
                  <span
                    key={stage}
                    className={cn(
                      'flex items-center gap-[6px] rounded-full px-3 py-[7px]',
                      'border border-[var(--glass-border)] bg-white/[0.05]',
                      'font-ui text-[12.5px] text-ink',
                      // Ensure min hit target height ≥ 44px on mobile via py padding
                      'min-h-[44px] sm:min-h-0',
                    )}
                  >
                    {/* Leading amber dot (via --warn) */}
                    <span
                      className="h-[7px] w-[7px] flex-none rounded-full bg-warn"
                      aria-hidden="true"
                    />
                    {meta.label}
                    {meta.estimate && (
                      <span className="font-mono text-[10.5px] text-ink-muted">
                        {meta.estimate}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {/* Pin-fate table — CONDITIONAL: only when pins are at stake (hybrid C) */}
          {hasPins && pinFates && (
            <table
              className="mb-[14px] w-full border-collapse text-[12.5px]"
              aria-label="Pin fate per scene"
            >
              <tbody>
                {pinFates.map((row, i) => (
                  <tr
                    key={i}
                    className="border-t border-[var(--glass-border)] first:border-t-0"
                  >
                    <td className="py-[7px] pr-2 text-ink-secondary">{row.label}</td>
                    <td
                      className={cn(
                        'py-[7px] text-right',
                        row.survives ? 'text-[#30d158]' : 'text-warn',
                      )}
                    >
                      {row.survives ? '✓ survives' : '⚠ re-times — pin lost'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Buttons */}
          <div className="flex items-center justify-end gap-[10px]">
            {/* Cancel — ghost pill, INITIAL FOCUS (the costly action is Reopen).
                We use a native <button> here so we can attach a ref for focus
                management (Button does not forward refs). */}
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              aria-label="Cancel — discard edit"
              className={cn(
                'inline-flex min-h-[44px] items-center justify-center gap-2',
                'rounded-full px-[18px] py-[9px] font-ui text-[13px] font-medium',
                'glass glass-hover text-ink',
                'transition-all duration-150 ease-out',
              )}
            >
              Cancel
            </button>

            {/* Reopen — warn variant (amber), min hit target */}
            <Button
              variant="warn"
              className="min-h-[44px] rounded-full px-5 py-[9px] font-ui text-[13px]"
              onClick={onReopen}
              aria-label={`Reopen ${gateName} gate`}
            >
              Reopen {gateName}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
