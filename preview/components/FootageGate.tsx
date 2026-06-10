'use client';

import {useRef, useState} from 'react';
import {Eyebrow, Badge} from './ui';

export type Candidate = {rank: number; thumbUrl: string | null; durationFrames: number | null; selected: boolean};
export type Provenance = {
  source: string; // "auto" | "pick" | "re_query" | "uploaded"
  query: string | null;
  rank: number | null;
  pexelsId: number | null;
  pexelsUrl: string | null;
};
export type GateScene = {
  index: number;
  template: string | null;
  needsFootage: boolean;
  candidates: Candidate[];
  provenance: Provenance | null;
};

// Mirrors backend/pipeline/media_probe.py (VIDEO_EXTS + IMAGE_EXTS).
const UPLOAD_ACCEPT = '.mp4,.mov,.webm,.m4v,.jpg,.jpeg,.png,.webp';

const SOURCE_LABEL: Record<string, string> = {
  auto: 'auto', pick: 'picked', re_query: 're-queried', uploaded: 'uploaded',
};
const SOURCE_TONE: Record<string, 'dim' | 'blue' | 'purple' | 'green'> = {
  auto: 'dim', pick: 'blue', re_query: 'purple', uploaded: 'green',
};

/** A.6.4 — current-state provenance badges: where this scene's clip came from. */
function ProvenanceBadges({p}: {p: Provenance}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Badge tone={SOURCE_TONE[p.source] ?? 'dim'}>{SOURCE_LABEL[p.source] ?? p.source}</Badge>
      {p.rank != null ? <Badge tone="dim">rank {p.rank}</Badge> : null}
      {/* the source term: uploaded filename, or the re-query string the user searched */}
      {(p.source === 'uploaded' || p.source === 're_query') && p.query ? (
        <span className="max-w-[160px] truncate font-mono text-[11px] text-ink-muted" title={p.query}>
          {p.query}
        </span>
      ) : null}
      {p.pexelsUrl ? (
        <a
          href={p.pexelsUrl}
          target="_blank"
          rel="noreferrer"
          className="font-ui text-[11px] text-[#60a5fa] underline-offset-2 hover:underline"
        >
          Pexels ↗
        </a>
      ) : null}
    </div>
  );
}

function SceneRow({
  scene,
  busy,
  onPick,
  onRequery,
  onUpload,
}: {
  scene: GateScene;
  busy: boolean;
  onPick: (scene: number, rank: number) => void;
  onRequery: (scene: number, query: string) => void;
  onUpload: (scene: number, file: File) => void;
}) {
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const s = scene;

  const submitRequery = () => {
    const q = query.trim();
    if (!q || busy) return;
    onRequery(s.index, q);
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="font-ui text-[12px] text-ink-secondary">Scene {s.index + 1}</div>
        {s.provenance ? <ProvenanceBadges p={s.provenance} /> : null}
      </div>

      {s.candidates.length > 0 ? (
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
      ) : null}

      {/* A.6.2 re-query + A.6.3 upload */}
      <div className="mt-2 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRequery();
          }}
          disabled={busy}
          placeholder="Search a new clip…"
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 font-ui text-[12px] text-ink placeholder:text-ink-muted focus:border-white/30 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={submitRequery}
          disabled={busy || !query.trim()}
          className="shrink-0 rounded-md border border-white/10 px-2.5 py-1.5 font-ui text-[12px] text-ink-secondary transition hover:border-white/30 hover:text-ink disabled:opacity-40"
        >
          Re-query
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title={`Upload a video or image (${UPLOAD_ACCEPT})`}
          className="shrink-0 rounded-md border border-white/10 px-2.5 py-1.5 font-ui text-[12px] text-ink-secondary transition hover:border-white/30 hover:text-ink disabled:opacity-40"
        >
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(s.index, f);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
      </div>
    </div>
  );
}

export function FootageGate({
  scenes,
  busy,
  onPick,
  onRequery,
  onUpload,
}: {
  scenes: GateScene[];
  busy: boolean;
  onPick: (scene: number, rank: number) => void;
  onRequery: (scene: number, query: string) => void;
  onUpload: (scene: number, file: File) => void;
}) {
  const footage = scenes.filter((s) => s.needsFootage);
  if (footage.length === 0) return null;
  return (
    <div className="glass rounded-xl p-5">
      <Eyebrow>Footage gate</Eyebrow>
      <p className="mt-2 font-ui text-[12px] text-ink-muted">
        Pick a clip, re-query Pexels, or upload your own — the preview updates live (re-render to export).
      </p>
      <div className="mt-4 flex flex-col gap-5">
        {footage.map((s) => (
          <SceneRow key={s.index} scene={s} busy={busy} onPick={onPick} onRequery={onRequery} onUpload={onUpload} />
        ))}
      </div>
    </div>
  );
}
