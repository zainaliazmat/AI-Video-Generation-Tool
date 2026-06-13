'use client';

import {Eyebrow} from './ui';
import type {ProjectMeta} from '@/lib/projects';
import {discriminateStub} from '@/lib/projects';

function fmtDuration(frames: number, fps: number): string {
  return `${(frames / fps).toFixed(1)}s`;
}

function fmtAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function ProjectList({
  projects,
  selectedId,
  onOpen,
  onDelete,
  onRetry,
}: {
  projects: ProjectMeta[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** Optional: called when user clicks "Retry" on a failed stub. */
  onRetry?: (id: string) => void;
}) {
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>Library</Eyebrow>
      {projects.length === 0 ? (
        <p className="mt-3 font-ui text-[13px] text-ink-muted">
          No videos yet — generate one to get started.
        </p>
      ) : (
        <div className="mt-3 flex flex-col">
          {projects.map((p) => {
            const kind = discriminateStub(p);

            if (kind === 'building') {
              // Stub: actively building — show topic + spinner affordance, no open link
              return (
                <div
                  key={p.id}
                  className={`flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 ${
                    p.id === selectedId ? 'bg-white/[0.06]' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate font-ui text-[13.5px] font-medium text-ink-muted">
                      {/* Inline spinner */}
                      <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-white/60" aria-hidden />
                      <span className="truncate">{p.topic || 'Building…'}</span>
                    </div>
                    <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                      building · {fmtAgo(p.createdAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      onClick={() => onDelete(p.id)}
                      className="font-ui text-[12px] text-ink-muted transition-colors hover:text-ink"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            }

            if (kind === 'failed') {
              // Stub: abandoned / script failed — show topic dimmed + Retry + Delete
              return (
                <div
                  key={p.id}
                  className={`flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 opacity-60 ${
                    p.id === selectedId ? 'bg-white/[0.06]' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-ui text-[13.5px] font-medium text-ink-muted line-through">
                      {p.topic || 'Unknown topic'}
                    </div>
                    <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                      draft — script failed · {fmtAgo(p.createdAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {onRetry && (
                      <button
                        onClick={() => onRetry(p.id)}
                        className="font-ui text-[12px] text-accent-1 transition-opacity hover:opacity-80"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      onClick={() => onDelete(p.id)}
                      className="font-ui text-[12px] text-ink-muted transition-colors hover:text-ink"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            }

            // kind === 'finished' — standard finished-project card (unchanged behavior)
            const durationStr =
              typeof p.durationInFrames === 'number' &&
              p.durationInFrames > 0 &&
              typeof p.fps === 'number' &&
              p.fps > 0
                ? fmtDuration(p.durationInFrames, p.fps)
                : null;

            return (
              <div
                key={p.id}
                className={`flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-150 hover:bg-white/[0.04] ${
                  p.id === selectedId ? 'bg-white/[0.06]' : ''
                }`}
              >
                <button onClick={() => onOpen(p.id)} className="min-w-0 text-left">
                  <div className="truncate font-ui text-[13.5px] font-medium text-ink">{p.title}</div>
                  <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                    {durationStr ? `${durationStr} · ` : ''}{fmtAgo(p.createdAt)}
                    {p.hasRender ? ' · rendered' : ''}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-3">
                  {p.hasRender && (
                    <a
                      href={`/api/projects/${p.id}/video`}
                      download="video.mp4"
                      className="font-ui text-[12px] text-accent-3 transition-opacity hover:opacity-80"
                    >
                      ↓ MP4
                    </a>
                  )}
                  <button
                    onClick={() => onDelete(p.id)}
                    className="font-ui text-[12px] text-ink-muted transition-colors hover:text-ink"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
