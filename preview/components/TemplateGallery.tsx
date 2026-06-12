'use client';

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {motion, useReducedMotion} from 'framer-motion';
import {cn} from '@/lib/cn';
import {Eyebrow, Button} from './ui';
import {TemplateCard, StageChecklist} from './TemplateCard';
import {TemplateDrawer} from './TemplateDrawer';
import type {TemplateMeta} from '@/lib/templates';
import type {UnifiedItem, Tab} from '@/lib/marketplace-ui';
import {deriveView} from '@/lib/marketplace-ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Task-2 bag passed down from the server page. */
export interface GalleryBag {
  installed: UnifiedItem[];
  catalog: UnifiedItem[];
  installedIds: string[];
}

export interface InstallState {
  status: 'idle' | 'installing' | 'failed';
  stage?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// SSE frame parser helpers
// ---------------------------------------------------------------------------

/**
 * Parse SSE data frames from a TextDecoder chunk buffer.
 * Handles partial frames by retaining the incomplete tail in a carry buffer.
 * Returns [parsed events[], remaining carry].
 */
function parseSSEChunk(carry: string, chunk: string): [Array<{type: string; [k: string]: unknown}>, string] {
  const text = carry + chunk;
  const events: Array<{type: string; [k: string]: unknown}> = [];
  // SSE frames end with double newline (\n\n)
  const parts = text.split('\n\n');
  // The last part is either empty (fully consumed) or an incomplete frame
  const incomplete = parts.pop() ?? '';
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6)) as {type: string; [k: string]: unknown};
          events.push(parsed);
        } catch {
          // Ignore malformed JSON in SSE frames
        }
      }
    }
  }
  return [events, incomplete];
}

// ---------------------------------------------------------------------------
// SSE install driver
// ---------------------------------------------------------------------------

type InstallInput =
  | {kind: 'catalog'; catalogId: string; update?: boolean; confirmReplace?: boolean}
  | {kind: 'zip'; file: File};

/**
 * Drive the /api/templates/install SSE stream.
 * Calls onStage on each stage event, onDone on completion, onError on failure.
 */
async function driveInstall(
  input: InstallInput,
  onStage: (stage: string) => void,
  onDone: () => void,
  onError: (stage: string, message: string) => void,
): Promise<void> {
  let body: BodyInit;
  let headers: Record<string, string> | undefined;

  if (input.kind === 'catalog') {
    body = JSON.stringify({catalogId: input.catalogId, update: input.update, confirmReplace: input.confirmReplace});
    headers = {'Content-Type': 'application/json'};
  } else {
    const fd = new FormData();
    fd.append('file', input.file);
    body = fd;
    // Let the browser set multipart boundary — no explicit Content-Type
  }

  let res: Response;
  try {
    res = await fetch('/api/templates/install', {method: 'POST', headers, body});
  } catch {
    onError('network', 'Network error — could not reach the install route.');
    return;
  }

  if (!res.body) {
    onError('network', 'No response body from install route.');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let value: Uint8Array | undefined;
    let done: boolean;
    try {
      ({value, done} = await reader.read());
    } catch {
      onError('network', 'Stream read error during install.');
      return;
    }
    if (done) break;
    const chunk = decoder.decode(value, {stream: true});
    const [events, newCarry] = parseSSEChunk(carry, chunk);
    carry = newCarry;
    for (const ev of events) {
      if (ev.type === 'stage' && typeof ev.stage === 'string') {
        onStage(ev.stage);
      } else if (ev.type === 'done') {
        onDone();
        return;
      } else if (ev.type === 'error') {
        const stage = typeof ev.stage === 'string' ? ev.stage : 'unknown';
        const message = typeof ev.message === 'string' ? ev.message : 'Unknown error';
        onError(stage, message);
        return;
      }
    }
  }
  // Stream ended without a terminal event — treat as done
  onDone();
}

// ---------------------------------------------------------------------------
// Gallery component
// ---------------------------------------------------------------------------

export function TemplateGallery({
  templates,
  galleryBag,
}: {
  templates: TemplateMeta[];
  galleryBag: GalleryBag;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('installed');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [installStates, setInstallStates] = useState<Record<string, InstallState>>({});
  // Optimistic "just-installed" set: prevents flash of ghost "Install" button
  // during the router.refresh() round-trip after a successful install (I1).
  const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set());
  // Drawer: hold the selected UnifiedItem directly (§16.9/§16.10)
  const [selected, setSelected] = useState<UnifiedItem | null>(null);
  // Drag overlay (lg-gated)
  const [dragDepth, setDragDepth] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tab bar ref for ArrowKey navigation (§16.13 tablist)
  const tabBarRef = useRef<HTMLDivElement>(null);

  const installedIdsSet = useMemo(() => new Set(galleryBag.installedIds), [galleryBag.installedIds]);

  const {items, installedCount, marketplaceCount, kinds, zeroResult} = useMemo(
    () =>
      deriveView({
        installed: galleryBag.installed,
        catalog: galleryBag.catalog,
        installedIds: installedIdsSet,
        tab,
        query,
        kind,
      }),
    [galleryBag.installed, galleryBag.catalog, installedIdsSet, tab, query, kind],
  );

  // Reset kind pill when switching tabs (old pill may not exist in the new tab)
  const handleTabChange = useCallback(
    (next: Tab) => {
      setTab(next);
      setKind('all');
    },
    [],
  );

  // §16.13 tablist: ArrowLeft/Right move focus + activate tab; no focus loss on switch.
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, current: Tab) => {
      const TABS: Tab[] = ['installed', 'marketplace'];
      const idx = TABS.indexOf(current);
      let next: Tab | null = null;
      if (e.key === 'ArrowRight') {
        next = TABS[(idx + 1) % TABS.length];
      } else if (e.key === 'ArrowLeft') {
        next = TABS[(idx - 1 + TABS.length) % TABS.length];
      }
      if (next) {
        e.preventDefault();
        handleTabChange(next);
        // Move DOM focus to the newly activated tab button
        const btn = tabBarRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`);
        btn?.focus();
      }
    },
    [handleTabChange],
  );

  // Reset kind when query changes and selected kind disappears from the new kind list
  useEffect(() => {
    if (kind !== 'all' && !kinds.includes(kind)) {
      setKind('all');
    }
  }, [kinds, kind]);

  // -------------------------------------------------------------------------
  // Install handler
  // -------------------------------------------------------------------------

  const startInstall = useCallback(
    (input: InstallInput, id: string) => {
      setInstallStates((prev) => ({...prev, [id]: {status: 'installing', stage: 'validating'}}));
      // For catalog installs, the real template id equals the key.
      // For zip installs the key is __zip__<filename> — no optimistic id available.
      const catalogId = id.startsWith('__zip__') ? null : id;
      driveInstall(
        input,
        (stage) => setInstallStates((prev) => ({...prev, [id]: {status: 'installing', stage}})),
        () => {
          setInstallStates((prev) => {
            const next = {...prev};
            delete next[id];
            return next;
          });
          // Optimistically mark as installed so the card shows "Installed ✓"
          // during the router.refresh() round-trip — prevents flash of "Install" (I1).
          if (catalogId) {
            setJustInstalled((prev) => new Set(prev).add(catalogId));
          }
          router.refresh();
        },
        (stage, error) => {
          setInstallStates((prev) => ({...prev, [id]: {status: 'failed', stage, error}}));
        },
      );
    },
    [router],
  );

  const handleInstallItem = useCallback(
    (item: UnifiedItem, opts?: {update?: boolean; confirmReplace?: boolean}) => {
      startInstall(
        {kind: 'catalog', catalogId: item.id, update: opts?.update, confirmReplace: opts?.confirmReplace},
        item.id,
      );
    },
    [startInstall],
  );

  const handleZipInstall = useCallback(
    (file: File) => {
      // Use the filename as a transient key (stable for the install duration)
      const id = `__zip__${file.name}`;
      startInstall({kind: 'zip', file}, id);
    },
    [startInstall],
  );

  const handleDismissError = useCallback((id: string) => {
    setInstallStates((prev) => {
      const next = {...prev};
      delete next[id];
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // File picker
  // -------------------------------------------------------------------------

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleZipInstall(file);
        // Reset so the same file can be re-picked
        e.target.value = '';
      }
    },
    [handleZipInstall],
  );

  // -------------------------------------------------------------------------
  // Drag overlay (≥lg only: 1024px+)
  // -------------------------------------------------------------------------

  const isLg = useCallback(() => window.matchMedia('(min-width:1024px)').matches, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!isLg()) return;
      setDragDepth((d) => d + 1);
    },
    [isLg],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!isLg()) return;
      setDragDepth((d) => Math.max(0, d - 1));
    },
    [isLg],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // required to allow drop
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragDepth(0);
      if (!isLg()) return;
      const file = e.dataTransfer.files?.[0];
      if (file && file.name.endsWith('.zip')) {
        handleZipInstall(file);
      }
    },
    [isLg, handleZipInstall],
  );

  const dragActive = dragDepth > 0;

  // -------------------------------------------------------------------------
  // Find a TemplateMeta for the drawer (for items in installed tab)
  // -------------------------------------------------------------------------
  const findMeta = useCallback(
    (item: UnifiedItem): TemplateMeta | null => {
      return templates.find((t) => t.id === item.id) ?? null;
    },
    [templates],
  );

  // Collect active zip-install entries for the ZIP install surface (B1).
  // Keys are __zip__<filename>; these never match a catalog/installed item.id.
  const zipInstalls = useMemo(
    () =>
      Object.entries(installStates)
        .filter(([k]) => k.startsWith('__zip__'))
        .map(([k, state]) => ({key: k, filename: k.slice('__zip__'.length), state})),
    [installStates],
  );

  const otherTab: Tab = tab === 'installed' ? 'marketplace' : 'installed';
  const otherTabLabel = tab === 'installed' ? 'Marketplace' : 'Installed';

  return (
    <main
      className="relative z-[1] mx-auto max-w-[1040px] px-7 py-10 sm:px-8 sm:py-12"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Whole-page drag overlay (≥lg only) — mouse-only path; aria-hidden so SR
          doesn't announce it. The "⇪ Install from .zip" button is the keyboard path. */}
      {dragActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
          style={{background: 'rgba(8,12,24,0.82)', backdropFilter: 'blur(6px)'}}
        >
          <div
            className="rounded-[16px] px-14 py-10 text-center"
            style={{border: '2px dashed rgba(99,102,241,0.4)'}}
          >
            <div className="font-ui text-[16px] font-semibold text-ink">Drop to install · .zip template package</div>
            <div className="mt-2 max-w-[360px] font-ui text-[12px] leading-[1.5] text-ink-secondary">
              Templates run code on your machine during install validation, preview, and export. Install only templates you trust.
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="sr-only"
        onChange={handleFileChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Header */}
      <motion.header
        initial={{opacity: 0, y: 12}}
        animate={{opacity: 1, y: 0}}
        transition={{type: 'spring', stiffness: 300, damping: 30}}
      >
        <Eyebrow>Template library</Eyebrow>
        <h1 className="mt-2 font-ui text-[clamp(28px,4vw,40px)] font-semibold leading-[1.08] tracking-[-0.03em] text-ink">
          {installedCount} drop-in templates
        </h1>
        <p className="mt-3 max-w-[56ch] font-ui text-[14px] leading-relaxed text-ink-secondary">
          Every template discovered in{' '}
          <code className="font-mono text-[13px]">templates/</code>, plus the local marketplace
          catalog.
          {marketplaceCount > 0 && (
            <> + {marketplaceCount} more in the local marketplace</>
          )}
        </p>
      </motion.header>

      {/* Controls row: segmented tabs + search + ghost install button */}
      <div className="mt-7 flex flex-wrap items-center gap-3">
        {/* Segmented tab bar — §16.13 tablist pattern */}
        <div
          ref={tabBarRef}
          role="tablist"
          aria-label="Template tabs"
          className="glass flex rounded-full p-[3px]"
        >
          <button
            role="tab"
            type="button"
            data-tab="installed"
            aria-selected={tab === 'installed'}
            tabIndex={tab === 'installed' ? 0 : -1}
            onClick={() => handleTabChange('installed')}
            onKeyDown={(e) => handleTabKeyDown(e, 'installed')}
            className={cn(
              'focus-ring rounded-full px-4 py-[7px] font-ui text-[12.5px] font-medium transition-colors duration-150',
              tab === 'installed'
                ? 'bg-white/[0.12] text-ink'
                : 'text-ink-secondary hover:text-ink',
            )}
          >
            Installed{' '}
            <span className="ml-[5px] font-mono text-[10.5px] opacity-65">{installedCount}</span>
          </button>
          <button
            role="tab"
            type="button"
            data-tab="marketplace"
            aria-selected={tab === 'marketplace'}
            tabIndex={tab === 'marketplace' ? 0 : -1}
            onClick={() => handleTabChange('marketplace')}
            onKeyDown={(e) => handleTabKeyDown(e, 'marketplace')}
            className={cn(
              'focus-ring rounded-full px-4 py-[7px] font-ui text-[12.5px] font-medium transition-colors duration-150',
              tab === 'marketplace'
                ? 'bg-white/[0.12] text-ink'
                : 'text-ink-secondary hover:text-ink',
            )}
          >
            Marketplace{' '}
            <span className="ml-[5px] font-mono text-[10.5px] opacity-65">{marketplaceCount}</span>
          </button>
        </div>

        {/* Search */}
        <div className="glass flex min-w-[220px] flex-1 items-center gap-2 rounded-full px-3.5 py-2">
          <span className="font-ui text-[13px] text-ink-muted" aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, tags, kind, author"
            className="focus-ring w-full rounded-full bg-transparent font-ui text-[13px] text-ink placeholder:text-ink-muted"
            aria-label="Search templates"
          />
        </div>

        {/* Authoring guide link — same ghost grammar as the zip button */}
        <Link
          href="/templates/guide"
          className="focus-ring glass glass-hover inline-flex items-center gap-[7px] rounded-full px-[15px] py-2 font-ui text-[12.5px] font-medium text-ink"
        >
          ✎ Template guide
        </Link>

        {/* Ghost install from zip button — keyboard/SR path for install; drag overlay is mouse-only */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Install template from .zip file"
          className="focus-ring glass glass-hover inline-flex items-center gap-[7px] rounded-full px-[15px] py-2 font-ui text-[12.5px] font-medium text-ink"
        >
          ⇪ Install from .zip
        </button>
      </div>

      {/* Kind pills row */}
      <div className="mt-4 flex flex-wrap gap-2">
        <KindPill label="All" active={kind === 'all'} onClick={() => setKind('all')} />
        {kinds.map((k) => (
          <KindPill key={k} label={k} active={kind === k} onClick={() => setKind(k)} />
        ))}
      </div>

      {/* Trust line */}
      <p className="mt-4 font-ui text-[12px] text-ink-muted">
        Templates run code on your machine during install validation, preview, and export. Install
        only templates you trust.
      </p>

      {/* ZIP install surface (B1): renders a panel for each active __zip__* install */}
      {zipInstalls.length > 0 && (
        <div className="mt-5 flex flex-col gap-3">
          {zipInstalls.map(({key, filename, state}) => (
            <ZipInstallPanel
              key={key}
              filename={filename}
              state={state}
              onDismiss={() => handleDismissError(key)}
            />
          ))}
        </div>
      )}

      {/* Grid or zero-result */}
      {zeroResult.active ? (
        <ZeroResult
          query={query}
          tab={tab}
          otherTab={otherTab}
          otherTabLabel={otherTabLabel}
          otherTabMatches={zeroResult.otherTabMatches}
          onSwitchTab={() => handleTabChange(otherTab)}
          onClearSearch={() => setQuery('')}
        />
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => {
            // Catalog installs use item.id as key; zip installs use __zip__<filename>
            const installState = installStates[item.id] ?? {status: 'idle' as const};
            // Optimistic installed flag: treat as installed if server confirmed OR
            // if the current session just installed it (prevents "Install" flash — I1).
            // Once server payload confirms installed:true, prune from justInstalled.
            const effectiveInstalled = item.installed || justInstalled.has(item.id);
            if (item.installed && justInstalled.has(item.id)) {
              // Server has confirmed; prune on next render tick
              setJustInstalled((prev) => {
                if (!prev.has(item.id)) return prev;
                const next = new Set(prev);
                next.delete(item.id);
                return next;
              });
            }
            const effectiveItem = effectiveInstalled !== item.installed
              ? {...item, installed: effectiveInstalled}
              : item;
            return (
              <TemplateCard
                key={item.id}
                item={effectiveItem}
                installState={installState}
                onOpen={() => setSelected(item)}
                onInstall={(i, opts) => handleInstallItem(i, opts)}
                onDismissError={() => handleDismissError(item.id)}
              />
            );
          })}
        </div>
      )}

      <TemplateDrawer
        item={selected}
        meta={selected ? findMeta(selected) : null}
        onClose={() => setSelected(null)}
        onInstall={(item) => {
          handleInstallItem(item);
          setSelected(null);
        }}
        onUninstalled={() => {
          setSelected(null);
          router.refresh();
        }}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// ZIP install surface panel (B1)
// Renders a dismissible panel for each active __zip__* install entry.
// Shows the same StageChecklist or fail-box that catalog cards use.
// ---------------------------------------------------------------------------

function ZipInstallPanel({
  filename,
  state,
  onDismiss,
}: {
  filename: string;
  state: InstallState;
  onDismiss: () => void;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const hasFailed = state.status === 'failed';
  const isInstalling = state.status === 'installing';

  return (
    <div
      className={cn(
        'rounded-[10px] border px-4 py-3',
        hasFailed
          ? 'border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.07)]'
          : 'border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)]',
      )}
      role={hasFailed ? 'alert' : undefined}
    >
      {/* File name header */}
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="font-mono text-[11.5px] text-ink-secondary truncate">{filename}</span>
        {hasFailed && (
          <button
            type="button"
            onClick={onDismiss}
            className="focus-ring flex-shrink-0 rounded-sm font-ui text-[11px] text-ink-muted hover:text-ink"
            aria-label={`Dismiss failed install for ${filename}`}
          >
            Dismiss
          </button>
        )}
      </div>

      {/* Progress / fail box */}
      {isInstalling && (
        <StageChecklist currentStage={state.stage} reducedMotion={reducedMotion} />
      )}

      {hasFailed && (() => {
        const stage = state.stage ?? 'unknown';
        const error = state.error ?? 'Unknown error';
        const isLock = stage === 'lock';
        return isLock ? (
          <p className="font-ui text-[11.5px] text-ink-secondary">
            An install is already running — one at a time.
          </p>
        ) : (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.04em] text-[#f87171]">
              ✕ {stage}
            </div>
            <div className="mt-1 font-ui text-[11.5px] leading-[1.4] text-ink-secondary">{error}</div>
            <p className="mt-2 font-ui text-[10.5px] text-ink-muted">
              Tip: install.mjs doctor ./&lt;dir&gt; runs this exact gate locally.
            </p>
          </>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kind pill
// ---------------------------------------------------------------------------

function KindPill({label, active, onClick}: {label: string; active: boolean; onClick: () => void}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'focus-ring rounded-full border px-3.5 py-1.5 font-ui text-[12.5px] font-medium capitalize transition-colors duration-150',
        active
          ? 'border-transparent bg-white/[0.12] text-ink'
          : 'border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.04)] text-ink-secondary hover:bg-[rgba(255,255,255,0.07)]',
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Zero-result state (§16.2 cross-tab link)
// ---------------------------------------------------------------------------

function ZeroResult({
  query,
  tab,
  otherTabLabel,
  otherTabMatches,
  onSwitchTab,
  onClearSearch,
}: {
  query: string;
  tab: Tab;
  otherTab: Tab;
  otherTabLabel: string;
  otherTabMatches: number;
  onSwitchTab: () => void;
  onClearSearch: () => void;
}) {
  return (
    <div className="mt-10 flex justify-center">
      <div className="max-w-[380px] text-center">
        <div className="font-mono text-[22px] text-ink-muted">⌕</div>
        <h4 className="mt-2.5 font-ui text-[14.5px] font-semibold text-ink">
          No {tab === 'installed' ? 'installed' : 'marketplace'} templates match &ldquo;{query}&rdquo;
        </h4>
        <p className="mt-1.5 font-ui text-[12.5px] leading-relaxed text-ink-secondary">
          {otherTabMatches > 0 && (
            <>
              <button
                type="button"
                onClick={onSwitchTab}
                className="focus-ring rounded-sm text-[#a78bfa] hover:underline"
              >
                {otherTabMatches} match{otherTabMatches !== 1 ? 'es' : ''} in {otherTabLabel} →
              </button>
              <br />
            </>
          )}
          <button
            type="button"
            onClick={onClearSearch}
            className="focus-ring rounded-sm text-ink-muted hover:underline"
          >
            Clear search
          </button>
        </p>
      </div>
    </div>
  );
}
