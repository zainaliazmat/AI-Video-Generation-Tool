'use client';

import {useState} from 'react';
import {motion, useReducedMotion} from 'framer-motion';
import {Badge, Button} from './ui';
import {kindTone, frameRange} from '@/lib/template-ui';
import {cn} from '@/lib/cn';
import type {UnifiedItem} from '@/lib/marketplace-ui';
import type {InstallState} from './TemplateGallery';

// ---------------------------------------------------------------------------
// Stage checklist configuration (§16.3)
// ---------------------------------------------------------------------------

/** All pipeline stage names in order; 'done' is the terminal stage. */
const STAGES = ['validating', 'typecheck', 'assets', 'register', 'rendering-preview', 'done'] as const;
type StageName = (typeof STAGES)[number];

const STAGE_LABELS: Record<StageName, string> = {
  validating: 'validate',
  typecheck: 'typecheck',
  assets: 'assets',
  register: 'register',
  'rendering-preview': 'rendering preview',
  done: 'done',
};

/** Returns the index of the current stage (or -1 if unrecognised). */
function stageIndex(stage: string | undefined): number {
  if (!stage) return 0;
  const idx = STAGES.indexOf(stage as StageName);
  return idx >= 0 ? idx : 0;
}

// ---------------------------------------------------------------------------
// Kind-tone gradient for poster placeholder
// ---------------------------------------------------------------------------

const KIND_GRADIENT: Record<string, string> = {
  hook: 'linear-gradient(160deg,#101631,#5e5ce6)',
  scene: 'linear-gradient(135deg,#0a2540,#0a84ff 70%,#7cc4ff)',
  stat: 'linear-gradient(135deg,#06281e,#30d158 90%)',
  'lower-third': 'linear-gradient(200deg,#33214d,#8b5cf6)',
  transition: 'linear-gradient(200deg,#0a2540,#0a84ff 70%,#7cc4ff)',
  overlay: 'linear-gradient(180deg,#2a1133,#7a2050)',
  outro: 'linear-gradient(160deg,#1a0d00,#ff9f0a 90%)',
};

function kindGradient(kind: string): string {
  return KIND_GRADIENT[kind] ?? 'linear-gradient(135deg,#1b1f3a,#5e5ce6,#a78bfa)';
}

// ---------------------------------------------------------------------------
// TemplateCard props
// ---------------------------------------------------------------------------

export interface TemplateCardProps {
  item: UnifiedItem;
  installState: InstallState;
  onOpen: () => void;
  onInstall: (item: UnifiedItem, opts?: {update?: boolean; confirmReplace?: boolean}) => void;
  onDismissError: () => void;
}

// ---------------------------------------------------------------------------
// TemplateCard
// ---------------------------------------------------------------------------

/**
 * Variant-aware template card.
 *
 * - Installed tab: poster + name/byline (author · vX · frameRange) + kind badge;
 *   core = dim "core — protected"; non-core + uncommitted = dim "uncommitted" badge.
 *   No card-foot uninstall (that's the drawer, §16.10).
 *
 * - Marketplace tab (catalog source): poster/gradient + name + byline (author · vX) +
 *   kind badge + description + tags + card-foot action:
 *     idle/not-installed → ghost "Install" (GHOST, §16.8 — one tinted install is in the drawer)
 *     updateAvailable    → ghost "Update to x.y.z"
 *     installed          → green "Installed ✓" flip
 *     installing         → stage checklist (§16.3)
 *     failed             → fail box (§16.5)
 */
export function TemplateCard({item, installState, onOpen, onInstall, onDismissError}: TemplateCardProps) {
  const [hover, setHover] = useState(false);
  const reducedMotion = useReducedMotion();

  const isInstalled = item.source === 'installed' || item.installed;
  const isCatalog = item.source === 'catalog';
  const isCore = item.author === 'core';
  const hasFailed = installState.status === 'failed';
  const isInstalling = installState.status === 'installing';

  return (
    <div
      className={cn(
        'content-card flex flex-col overflow-hidden text-left transition-transform duration-150',
        hasFailed && 'border-[rgba(239,68,68,0.35)]',
      )}
    >
      {/* Poster */}
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="focus-ring group relative block w-full overflow-hidden bg-black"
        style={{aspectRatio: '9/16', maxHeight: '240px'}}
        tabIndex={0}
        aria-label={`Open ${item.name} details`}
      >
        {hover && item.mp4 ? (
          <video
            src={item.mp4}
            poster={item.poster ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            className="h-full w-full object-cover"
          />
        ) : item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.poster} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{background: kindGradient(item.kind)}}
          />
        )}
        {item.mp4 && (
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] text-white/80 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            ▶ loop
          </div>
        )}
      </button>

      {/* Meta */}
      <div className="flex flex-1 flex-col gap-2 px-3 pb-3 pt-2.5">
        {/* Row 1: name + badge(s) */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onOpen}
              className="focus-ring block truncate rounded-sm font-ui text-[13px] font-medium text-ink hover:underline"
            >
              {item.name}
            </button>
            <div className="mt-0.5 font-mono text-[10.5px] text-ink-muted">
              {item.author} · v{item.version}
              {item.source === 'installed' && item.durationFrames
                ? ` · ${frameRange(item.durationFrames)}`
                : null}
            </div>
          </div>
          {/* Badge stack: kind + uncommitted (if applicable) */}
          <div className="flex flex-shrink-0 flex-col items-end gap-1">
            <Badge tone={kindTone(item.kind)}>{item.kind}</Badge>
            {item.source === 'installed' && !isCore && item.uncommitted && (
              <Badge tone="dim">uncommitted</Badge>
            )}
          </div>
        </div>

        {/* Description + tags (catalog only) */}
        {isCatalog && item.description && (
          <p className="font-ui text-[12px] leading-[1.45] text-ink-secondary">{item.description}</p>
        )}
        {isCatalog && item.tags && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-[5px]">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-white/[0.04] px-[7px] py-[2px] font-mono text-[9.5px] text-ink-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Card-foot area */}
        <CardFoot
          item={item}
          installState={installState}
          isInstalling={isInstalling}
          hasFailed={hasFailed}
          isCore={isCore}
          reducedMotion={reducedMotion ?? false}
          onInstall={onInstall}
          onDismissError={onDismissError}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card foot — context-aware action area
// ---------------------------------------------------------------------------

function CardFoot({
  item,
  installState,
  isInstalling,
  hasFailed,
  isCore,
  reducedMotion,
  onInstall,
  onDismissError,
}: {
  item: UnifiedItem;
  installState: InstallState;
  isInstalling: boolean;
  hasFailed: boolean;
  isCore: boolean;
  reducedMotion: boolean;
  onInstall: (item: UnifiedItem, opts?: {update?: boolean; confirmReplace?: boolean}) => void;
  onDismissError: () => void;
}) {
  // Installed-tab cards: clean footer (no card-foot uninstall, §16.10)
  if (item.source === 'installed') {
    if (isCore) {
      return (
        <div className="mt-auto pt-1">
          <span className="font-mono text-[10px] text-ink-muted">core — protected</span>
        </div>
      );
    }
    // Non-core installed: no footer needed (drawer handles uninstall)
    return null;
  }

  // Catalog card — show the right state
  if (hasFailed) {
    const stage = installState.stage ?? 'unknown';
    const error = installState.error ?? 'Unknown error';
    const isLock = stage === 'lock';
    return (
      <div
        className="mt-auto rounded-[8px] border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.10)] px-[10px] py-2"
        role="alert"
      >
        {isLock ? (
          <p className="font-ui text-[11.5px] text-ink-secondary">
            An install is already running — one at a time.
          </p>
        ) : (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.04em] text-[#f87171]">
              ✕ {stage}
            </div>
            <div className="mt-1 font-ui text-[11.5px] leading-[1.4] text-ink-secondary">{error}</div>
            <div className="mt-[7px] flex gap-[10px]">
              <button
                type="button"
                onClick={() => onInstall(item)}
                className="focus-ring rounded-sm font-ui text-[11.5px] font-medium text-ink"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={onDismissError}
                className="focus-ring rounded-sm font-ui text-[11.5px] font-medium text-ink-muted"
              >
                Dismiss
              </button>
            </div>
            <p className="mt-2 font-ui text-[10.5px] text-ink-muted">
              Tip: install.mjs doctor ./&lt;dir&gt; runs this exact gate locally.
            </p>
          </>
        )}
      </div>
    );
  }

  if (isInstalling) {
    return <StageChecklist currentStage={installState.stage} reducedMotion={reducedMotion} />;
  }

  // Installed (derived from installedIds) but this is a catalog item
  if (item.installed) {
    if (item.updateAvailable && item.catalogVersion) {
      return (
        <button
          type="button"
          onClick={() => onInstall(item, {update: true})}
          className="focus-ring mt-auto w-full rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-0 py-2 font-ui text-[12.5px] font-medium text-ink transition-colors hover:bg-[rgba(255,255,255,0.07)]"
        >
          Update to {item.catalogVersion}
        </button>
      );
    }
    return (
      <div className="mt-auto w-full rounded-[8px] bg-[rgba(16,185,129,0.10)] py-2 text-center font-ui text-[12.5px] font-medium text-[#34d399]">
        Installed ✓
      </div>
    );
  }

  // Default: not installed, not installing, not failed
  return (
    <button
      type="button"
      onClick={() => onInstall(item)}
      className="focus-ring install-btn mt-auto w-full rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] px-0 py-2 font-ui text-[12.5px] font-medium text-ink transition-colors hover:bg-[rgba(255,255,255,0.07)]"
    >
      Install
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stage checklist (§16.3)
// ---------------------------------------------------------------------------

function StageChecklist({
  currentStage,
  reducedMotion,
}: {
  currentStage: string | undefined;
  reducedMotion: boolean;
}) {
  const currentIdx = stageIndex(currentStage);

  return (
    <div className="mt-auto flex flex-col gap-[7px]" aria-live="polite" aria-label="Install progress">
      {STAGES.filter((s) => s !== 'done').map((stage, idx) => {
        const isDone = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        const isPending = idx > currentIdx;
        const label = STAGE_LABELS[stage];
        const isRenderingPreview = stage === 'rendering-preview';

        return (
          <div key={stage}>
            <div
              className={cn(
                'flex items-center justify-between font-ui text-[11px]',
                isDone && 'text-[#30d158]',
                isCurrent && 'text-ink-secondary',
                isPending && 'text-ink-muted opacity-45',
              )}
            >
              <span className="flex items-center gap-1.5">
                {isDone && '✓ '}
                {isCurrent && (
                  <CurrentDot reducedMotion={reducedMotion} />
                )}
                <span className="font-mono text-[10px]">{label}</span>
              </span>
            </div>
            {isCurrent && isRenderingPreview && (
              <p className="mt-0.5 font-ui text-[10.5px] text-ink-muted">
                can take a couple of minutes
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CurrentDot({reducedMotion}: {reducedMotion: boolean}) {
  if (reducedMotion) {
    return <span className="inline-block h-[7px] w-[7px] rounded-full bg-[#a78bfa]" />;
  }
  return (
    <motion.span
      className="inline-block h-[7px] w-[7px] rounded-full bg-[#a78bfa]"
      animate={{opacity: [1, 0.3, 1]}}
      transition={{duration: 1.2, repeat: Infinity, ease: 'easeInOut'}}
    />
  );
}
