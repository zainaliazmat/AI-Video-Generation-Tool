'use client';

import {Eyebrow} from './ui';
import type {ProjectMeta} from '@/lib/projects';

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
}: {
  projects: ProjectMeta[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
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
          {projects.map((p) => (
            <div
              key={p.id}
              className={`flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-150 hover:bg-white/[0.04] ${
                p.id === selectedId ? 'bg-white/[0.06]' : ''
              }`}
            >
              <button onClick={() => onOpen(p.id)} className="min-w-0 text-left">
                <div className="truncate font-ui text-[13.5px] font-medium text-ink">{p.title}</div>
                <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                  {fmtDuration(p.durationInFrames, p.fps)} · {fmtAgo(p.createdAt)}
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
          ))}
        </div>
      )}
    </div>
  );
}
