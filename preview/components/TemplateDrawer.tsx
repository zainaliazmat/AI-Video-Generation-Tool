'use client';

import {useEffect, useState, useCallback} from 'react';
import {AnimatePresence, motion} from 'framer-motion';
import {Badge, Button, Eyebrow} from './ui';
import {kindTone, frameRange, propRows} from '@/lib/template-ui';
import {cn} from '@/lib/cn';
import type {TemplateMeta} from '@/lib/templates';
import type {UnifiedItem} from '@/lib/marketplace-ui';

// ---------------------------------------------------------------------------
// Kind-tone gradient for poster placeholder (mirrors TemplateCard)
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
// Content kinds where "use it" chip makes sense
// ---------------------------------------------------------------------------

const CONTENT_KINDS = new Set(['hook', 'scene', 'stat', 'lower-third', 'outro', 'transition']);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TemplateDrawerProps {
  /** The item to display, or null when the drawer is closed. */
  item: UnifiedItem | null;
  /** Legacy: if the item is installed, pass the full TemplateMeta for the props
   *  table + sampleProps sections. If not provided the table is omitted. */
  meta?: TemplateMeta | null;
  /** Called when the user dismisses the drawer. */
  onClose: () => void;
  /** Called from the marketplace drawer's Install button. */
  onInstall?: (item: UnifiedItem) => void;
  /** Called after a successful uninstall (so the gallery can router.refresh). */
  onUninstalled?: () => void;
}

// ---------------------------------------------------------------------------
// TemplateDrawer
// ---------------------------------------------------------------------------

/** Detail drawer for a template item.
 *
 * Two shapes:
 *  - Marketplace/catalog (item.source === 'catalog' && !item.installed):
 *    poster → name/byline → description/tags → THE one tinted Install button +
 *    §15.6 trust sentence → homepage link → dim "Props after install" note.
 *  - Installed (item.source === 'installed' || item.installed):
 *    Existing poster/preview + props table + sampleProps + §16.7 use-it
 *    affordance + §16.10 danger-zone uninstall (inline expand, no modal).
 */
export function TemplateDrawer({item, meta, onClose, onInstall, onUninstalled}: TemplateDrawerProps) {
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onClose]);

  const isInstalled = item ? (item.source === 'installed' || item.installed) : false;

  return (
    <AnimatePresence>
      {item && (
        <>
          <motion.div
            className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm"
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            exit={{opacity: 0}}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={`${item.name} — template details`}
            className="fixed right-0 top-0 z-40 flex h-full w-full max-w-[440px] flex-col gap-5 overflow-y-auto border-l border-glass bg-[#0b0b10] p-6"
            initial={{x: '100%'}}
            animate={{x: 0}}
            exit={{x: '100%'}}
            transition={{type: 'spring', stiffness: 320, damping: 34}}
          >
            {isInstalled ? (
              <InstalledDrawer
                item={item}
                meta={meta ?? null}
                onClose={onClose}
                onUninstalled={onUninstalled}
              />
            ) : (
              <CatalogDrawer
                item={item}
                onClose={onClose}
                onInstall={onInstall}
              />
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Close button (shared)
// ---------------------------------------------------------------------------

function CloseButton({onClose}: {onClose: () => void}) {
  return (
    <button
      onClick={onClose}
      className="focus-ring rounded-[7px] px-2 py-1 font-ui text-[13px] text-ink-muted transition-colors hover:bg-white/[0.06] hover:text-ink"
      aria-label="Close drawer"
    >
      ✕
    </button>
  );
}

// ---------------------------------------------------------------------------
// Catalog/marketplace drawer (§16.9)
// The screen's single tinted action lives here.
// §15.6 trust sentence lives here + the drag overlay — NOT per-card.
// ---------------------------------------------------------------------------

function CatalogDrawer({
  item,
  onClose,
  onInstall,
}: {
  item: UnifiedItem;
  onClose: () => void;
  onInstall?: (item: UnifiedItem) => void;
}) {
  const handleInstall = useCallback(() => {
    onInstall?.(item);
    onClose();
  }, [item, onInstall, onClose]);

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-ui text-[20px] font-semibold tracking-[-0.01em] text-ink">{item.name}</h2>
          <div className="mt-1.5 flex items-center gap-2">
            <Badge tone={kindTone(item.kind)}>{item.kind}</Badge>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {/* Poster (static 9:16; kind-tone gradient placeholder when absent) */}
      <div className="overflow-hidden rounded-[var(--radius-md)] bg-black">
        {item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.poster}
            alt={item.name}
            className="aspect-[9/16] w-full object-cover"
          />
        ) : (
          <div
            className="flex aspect-[9/16] items-center justify-center"
            style={{background: kindGradient(item.kind)}}
          >
            <span className="font-ui text-[12px] text-white/50">{item.kind}</span>
          </div>
        )}
      </div>

      {/* Byline */}
      <div className="font-mono text-[11px] tabular-nums text-ink-muted">
        {item.author} · v{item.version}{item.license ? ` · ${item.license}` : ''}
      </div>

      {/* Description + tags */}
      {item.description && (
        <p className="font-ui text-[13.5px] leading-relaxed text-ink-secondary">{item.description}</p>
      )}
      {item.tags && item.tags.length > 0 && (
        <div className="flex flex-wrap gap-[6px]">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-white/[0.05] px-[8px] py-[3px] font-mono text-[10px] text-ink-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* THE one tinted Install action + §15.6 trust sentence */}
      <div className="rounded-[var(--radius-md)] border border-[rgba(99,102,241,0.18)] bg-[rgba(99,102,241,0.06)] p-4">
        <Button
          variant="primary"
          className="focus-ring w-full"
          onClick={handleInstall}
        >
          Install
        </Button>
        {/* §15.6 verbatim trust sentence — lives here + drag overlay only */}
        <p className="mt-3 font-ui text-[11.5px] leading-[1.5] text-ink-muted">
          Templates run code on your machine during install validation, preview, and export. Install only templates you trust.
        </p>
      </div>

      {/* Homepage link */}
      {item.homepage && (
        <a
          href={item.homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring inline-flex items-center gap-1.5 rounded-[6px] font-ui text-[12.5px] text-[#a78bfa] hover:underline"
        >
          Homepage ↗
        </a>
      )}

      {/* Dim note */}
      <p className="font-ui text-[11.5px] text-ink-muted">
        Props and live preview appear after install.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Installed-template drawer (§16.7 use-it + §16.10 danger-zone)
// ---------------------------------------------------------------------------

function InstalledDrawer({
  item,
  meta,
  onClose,
  onUninstalled,
}: {
  item: UnifiedItem;
  meta: TemplateMeta | null;
  onClose: () => void;
  onUninstalled?: () => void;
}) {
  const isCore = item.author === 'core';

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-ui text-[20px] font-semibold tracking-[-0.01em] text-ink">{item.name}</h2>
          <div className="mt-1.5 flex items-center gap-2">
            <Badge tone={kindTone(item.kind)}>{item.kind}</Badge>
            <span className="font-mono text-[11px] tabular-nums text-ink-muted">
              {item.durationFrames ? `${frameRange(item.durationFrames)} · ` : ''}v{item.version} · {item.author}
            </span>
          </div>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {/* Preview (mp4 or poster or gradient placeholder) */}
      <div className="overflow-hidden rounded-[var(--radius-md)] bg-black">
        {item.mp4 ? (
          <video
            src={item.mp4}
            poster={item.poster ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            className="aspect-[9/16] w-full object-cover"
          />
        ) : item.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.poster}
            alt={item.name}
            className="aspect-[9/16] w-full object-cover"
          />
        ) : (
          <div
            className="flex aspect-[9/16] items-center justify-center"
            style={{background: kindGradient(item.kind)}}
          >
            <span className="font-ui text-[12px] text-white/40">preview pending</span>
          </div>
        )}
      </div>

      {/* Props table (from TemplateMeta inputSchema) */}
      {meta && (
        <>
          <Section title="Props (inputSchema)">
            <PropsTable meta={meta} />
          </Section>
          <Section title="Sample props">
            <pre className="overflow-x-auto rounded-[8px] border border-glass bg-white/[0.02] p-3 font-mono text-[11.5px] leading-relaxed text-ink-secondary">
              {JSON.stringify(meta.sampleProps, null, 2)}
            </pre>
          </Section>
          <p className="font-mono text-[10.5px] text-ink-muted">apiVersion {meta.apiVersion}</p>
        </>
      )}

      {/* §16.7 Use-it affordance */}
      <UseItSection item={item} />

      {/* §16.10 Danger-zone uninstall or core-protected notice */}
      {isCore ? (
        <p className="font-mono text-[11px] text-ink-muted">core — protected</p>
      ) : (
        <DangerZone item={item} onClose={onClose} onUninstalled={onUninstalled} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// §16.7 Use-it affordance
// ---------------------------------------------------------------------------

function UseItSection({item}: {item: UnifiedItem}) {
  const [copied, setCopied] = useState(false);

  const isOverlay = item.kind === 'overlay';
  const hasChip = CONTENT_KINDS.has(item.kind);

  const phrase = `use ${item.id} for scene 2`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable — silent fail
    }
  }, [phrase]);

  return (
    <Section title="Use it">
      {isOverlay ? (
        <p className="font-ui text-[12.5px] leading-relaxed text-ink-secondary">
          Overlays can&rsquo;t yet be applied via Assemble chat — coming in a later release.
        </p>
      ) : hasChip ? (
        <div className="flex flex-col gap-2.5">
          {/* Copyable suggested-phrase chip */}
          <button
            type="button"
            onClick={handleCopy}
            aria-label={`Copy phrase: ${phrase}`}
            className={cn(
              'focus-ring inline-flex items-center gap-2 rounded-[8px] border px-3 py-2',
              'font-mono text-[11.5px] transition-colors duration-150',
              copied
                ? 'border-[rgba(48,209,88,0.3)] bg-[rgba(48,209,88,0.08)] text-[#30d158]'
                : 'border-[rgba(255,255,255,0.08)] bg-white/[0.04] text-ink-secondary hover:bg-white/[0.07]',
            )}
          >
            {copied ? '✓ copied' : phrase}
          </button>
          {/* Ghost link to Assemble gate / project library */}
          <a
            href="/"
            className="focus-ring inline-flex items-center gap-1 rounded-[6px] font-ui text-[12px] text-ink-muted hover:text-ink hover:underline"
          >
            Open a project&rsquo;s Assemble gate →
          </a>
        </div>
      ) : (
        <p className="font-ui text-[12.5px] leading-relaxed text-ink-secondary">
          No direct use-it shortcut for this template kind.
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// §16.10 Danger-zone uninstall — expands in place, no modal
// ---------------------------------------------------------------------------

interface RefData {
  total: number;
  files: Array<{path: string; count: number}>;
}

function DangerZone({
  item,
  onClose,
  onUninstalled,
}: {
  item: UnifiedItem;
  onClose: () => void;
  onUninstalled?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [refs, setRefs] = useState<RefData | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);

  // Lazy-fetch reference count on expand (§16.10: don't fetch until expanded)
  const handleExpand = useCallback(async () => {
    setExpanded(true);
    if (refs !== null || refsLoading) return;
    setRefsLoading(true);
    setRefsError(null);
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(item.id)}`);
      if (!res.ok) {
        const body = (await res.json()) as {error?: string};
        setRefsError(body.error ?? `HTTP ${res.status}`);
      } else {
        const data = (await res.json()) as RefData;
        setRefs(data);
      }
    } catch {
      setRefsError('Could not fetch project references.');
    } finally {
      setRefsLoading(false);
    }
  }, [item.id, refs, refsLoading]);

  const handleUninstall = useCallback(async () => {
    setUninstalling(true);
    setUninstallError(null);
    try {
      const res = await fetch(`/api/templates/${encodeURIComponent(item.id)}`, {method: 'DELETE'});
      if (!res.ok) {
        const body = (await res.json()) as {error?: string};
        setUninstallError(body.error ?? `HTTP ${res.status}`);
        setUninstalling(false);
        return;
      }
      const data = (await res.json()) as {removed: boolean};
      if (data.removed) {
        onClose();
        onUninstalled?.();
      } else {
        setUninstallError('Uninstall returned removed: false — check the server logs.');
        setUninstalling(false);
      }
    } catch {
      setUninstallError('Network error during uninstall.');
      setUninstalling(false);
    }
  }, [item.id, onClose, onUninstalled]);

  return (
    <div className="mt-auto border-t border-[rgba(255,255,255,0.06)] pt-4">
      {!expanded ? (
        <button
          type="button"
          onClick={handleExpand}
          className="focus-ring font-ui text-[12px] text-ink-muted transition-colors hover:text-[#f87171]"
          aria-label={`Uninstall ${item.name}`}
        >
          Uninstall&hellip;
        </button>
      ) : (
        <div className="rounded-[var(--radius-md)] border border-[rgba(239,68,68,0.2)] bg-[rgba(239,68,68,0.06)] p-4">
          <h3 className="font-ui text-[14px] font-semibold text-ink">
            Uninstall {item.name}?
          </h3>

          {/* §17.2 consequence copy VERBATIM */}
          <p className="mt-2 font-ui text-[12.5px] leading-[1.55] text-ink-secondary">
            Scenes and overlays will show the loud MissingTemplate placeholder; transitions fall back to a silent hard cut. Editing, assembling, or re-rendering those projects will fail loudly until the template is reinstalled or the scenes are re-templated.
          </p>

          {/* Project reference count (lazy-fetched on expand) */}
          <div className="mt-3 font-ui text-[12px]" aria-live="polite">
            {refsLoading && (
              <span className="text-ink-muted">Checking project references&hellip;</span>
            )}
            {refsError && (
              <span className="text-[#f87171]">Could not load references: {refsError}</span>
            )}
            {refs !== null && !refsLoading && (
              refs.total === 0 ? (
                <span className="text-ink-muted">Not referenced by any project.</span>
              ) : (
                <span className="text-amber-400/80">
                  ⚠ referenced by {refs.total} project{refs.total !== 1 ? 's' : ''}
                  {refs.files.length > 0 && (
                    <>
                      :{' '}
                      {refs.files
                        .slice(0, 4)
                        .map((f) => f.path.split('/').slice(-2)[0])
                        .join(', ')}
                    </>
                  )}
                </span>
              )
            )}
          </div>

          {/* Uninstall error */}
          {uninstallError && (
            <p className="mt-2 font-ui text-[12px] text-[#f87171]">{uninstallError}</p>
          )}

          {/* Actions */}
          <div className="mt-4 flex items-center gap-3">
            <Button
              variant="danger"
              className="focus-ring"
              onClick={handleUninstall}
              disabled={uninstalling}
              aria-label={`Confirm uninstall of ${item.name}`}
            >
              {uninstalling ? 'Uninstalling…' : 'Uninstall'}
            </Button>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="focus-ring font-ui text-[12.5px] text-ink-muted hover:text-ink"
              aria-label="Cancel uninstall"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Section + PropsTable helpers
// ---------------------------------------------------------------------------

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <section>
      <Eyebrow className="mb-2">{title}</Eyebrow>
      {children}
    </section>
  );
}

function PropsTable({meta}: {meta: TemplateMeta}) {
  const rows = propRows(meta.inputSchema);
  if (rows.length === 0) {
    return <p className="font-ui text-[12px] text-ink-muted">No input props.</p>;
  }
  return (
    <div className="overflow-hidden rounded-[8px] border border-glass">
      {rows.map((r, i) => (
        <div
          key={r.name}
          className={`flex items-center justify-between gap-3 px-3 py-2 ${i % 2 ? 'bg-white/[0.015]' : ''}`}
        >
          <span className="font-mono text-[12px] text-ink">
            {r.name}
            {r.required && <span className="ml-1 text-[#f87171]">*</span>}
          </span>
          <span className="truncate font-mono text-[11px] text-ink-muted">{r.type}</span>
        </div>
      ))}
    </div>
  );
}
