'use client';

import {Eyebrow} from './ui';

export type Candidate = {rank: number; thumbUrl: string | null; durationFrames: number | null; selected: boolean};
export type GateScene = {
  index: number;
  template: string | null;
  needsFootage: boolean;
  candidates: Candidate[];
  provenance: {source: string} | null;
};

export function FootageGate({
  scenes,
  busy,
  onPick,
}: {
  scenes: GateScene[];
  busy: boolean;
  onPick: (scene: number, rank: number) => void;
}) {
  const footage = scenes.filter((s) => s.needsFootage && s.candidates.length > 0);
  if (footage.length === 0) return null;
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>Footage gate</Eyebrow>
      <p className="mt-2 font-ui text-[12px] text-ink-muted">
        Pick a different clip for any scene — the preview updates live (re-render to export).
      </p>
      <div className="mt-4 flex flex-col gap-5">
        {footage.map((s) => (
          <div key={s.index}>
            <div className="mb-2 font-ui text-[12px] text-ink-secondary">
              Scene {s.index + 1}
              {s.provenance ? <span className="text-ink-muted"> · {s.provenance.source}</span> : null}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {s.candidates.map((c) => (
                <button
                  key={c.rank}
                  disabled={busy || c.selected}
                  onClick={() => onPick(s.index, c.rank)}
                  className={`relative overflow-hidden rounded-md border transition ${
                    c.selected ? 'border-yellow-400 ring-1 ring-yellow-400' : 'border-white/10 hover:border-white/30'
                  } ${busy ? 'opacity-50' : ''}`}
                  title={`rank ${c.rank}`}
                >
                  {c.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbUrl} alt={`clip rank ${c.rank}`} className="aspect-[9/16] w-full object-cover" />
                  ) : (
                    <div className="aspect-[9/16] w-full bg-white/5" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
