'use client';

import {Eyebrow} from './ui';
import type {RenderRecord} from './RenderControls';

function fmtDuration(frames: number, fps: number): string {
  const secs = frames / fps;
  return `${secs.toFixed(1)}s`;
}

function fmtAgo(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

export function HistoryList({records}: {records: RenderRecord[]}) {
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>History</Eyebrow>
      {records.length === 0 ? (
        <p className="mt-3 font-ui text-[13px] text-ink-muted">
          No renders yet — your exports will appear here.
        </p>
      ) : (
        <div className="mt-3 flex flex-col">
          {records.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2.5 transition-colors duration-150 hover:bg-white/[0.04]"
            >
              <div className="min-w-0">
                <div className="truncate font-ui text-[13.5px] font-medium text-ink">
                  {r.title}
                </div>
                <div className="font-mono text-[11px] tabular-nums text-ink-muted">
                  {fmtDuration(r.durationInFrames, r.fps)} · {r.durationInFrames}f ·{' '}
                  {fmtAgo(r.at)}
                </div>
              </div>
              <a
                href={r.url}
                download="video.mp4"
                className="shrink-0 font-ui text-[12px] text-accent-3 transition-opacity hover:opacity-80"
              >
                ↓ MP4
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
