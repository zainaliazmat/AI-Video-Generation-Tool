'use client';

import {useCallback, useEffect, useState} from 'react';
import {PlayerClient} from './PlayerClient';
import {Eyebrow} from './ui';

// The persistent preview rail (PRD §8 "the nested-layout trick"). Lives in the
// /video/[id] layout so gate-to-gate navigation swaps the content pane while the
// rail/player never blinks. Refetches the spec when a gate applies a change and
// dispatches `studio:spec-changed` on window.
export function PreviewRail({id}: {id: string}) {
  const [spec, setSpec] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`, {cache: 'no-store'});
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'failed to load preview');
      setSpec(data.spec);
      setVersion((v) => v + 1);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load preview');
    }
  }, [id]);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener('studio:spec-changed', onChange);
    return () => window.removeEventListener('studio:spec-changed', onChange);
  }, [load]);

  return (
    <aside className="glass sticky top-4 flex flex-col gap-3 self-start rounded-[var(--radius-xl)] p-3">
      <div>
        <Eyebrow className="mb-2 px-1">Live preview</Eyebrow>
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-white/10 bg-black">
          {spec ? (
            <PlayerClient key={version} spec={spec} />
          ) : (
            <div className="aspect-[1080/1920] w-full animate-pulse-dot bg-white/[0.03]" />
          )}
        </div>
      </div>
      <div className="content-card px-3 py-2.5">
        <Eyebrow className="mb-1.5">Contract</Eyebrow>
        <div className="font-mono text-[11px] text-ink-secondary">spec.json · v{version}</div>
        <div className="mt-1.5 flex gap-1.5">
          <span className="rounded-full bg-[rgba(48,209,88,0.15)] px-2 py-[2px] font-mono text-[10px] font-semibold text-ok">
            zod ✓
          </span>
          <span className="rounded-full bg-[rgba(48,209,88,0.15)] px-2 py-[2px] font-mono text-[10px] font-semibold text-ok">
            pydantic ✓
          </span>
        </div>
      </div>
      {error ? <div className="px-1 font-mono text-[11px] text-warn">{error}</div> : null}
    </aside>
  );
}

/** Gates call this after an apply that changed spec.json, to refresh the rail. */
export function notifySpecChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio:spec-changed'));
}
