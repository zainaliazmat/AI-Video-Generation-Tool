'use client';

import {useCallback, useEffect, useState} from 'react';
import {PlayerClient} from './PlayerClient';
import {Eyebrow} from './ui';
import {useVideoLayout} from './VideoChrome';
import {railPaused} from '@/lib/playerBudget';

// The persistent preview rail (PRD §8 "the nested-layout trick"). Lives in the
// /video/[id] layout so gate-to-gate navigation swaps the content pane while the
// rail/player never blinks. Refetches the spec when a gate applies a change and
// dispatches `studio:spec-changed` on window.
// F-7: pills are bound to session_meta.py's REAL checks (Spec.model_validate +
// validate_spec against the template catalog); meta=null degrades to "unverified".
type RailMeta = {specVersion: number; pydanticValid: boolean; templatesValid: boolean} | null;

export function PreviewRail({id}: {id: string}) {
  const [spec, setSpec] = useState<any>(null);
  const [meta, setMeta] = useState<RailMeta>(null);
  const [fetchCount, setFetchCount] = useState(0); // player remount key, NOT a version
  const [error, setError] = useState<string | null>(null);
  // T6: auto-pause while a per-scene player owns playback; arrival auto-play once.
  const {openSceneIndex} = useVideoLayout();
  const [playSignal, setPlaySignal] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${id}`, {cache: 'no-store'});
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'failed to load preview');
      setSpec(data.spec);
      setMeta(data.meta ?? null);
      setFetchCount((v) => v + 1);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load preview');
    }
  }, [id]);

  useEffect(() => {
    load();
    const onChange = () => load();
    const onPlay = () => setPlaySignal((n) => n + 1); // arrival auto-play (ruling 12)
    window.addEventListener('studio:spec-changed', onChange);
    window.addEventListener('studio:rail-play', onPlay);
    return () => {
      window.removeEventListener('studio:spec-changed', onChange);
      window.removeEventListener('studio:rail-play', onPlay);
    };
  }, [load]);

  return (
    <aside className="glass sticky top-4 flex flex-col gap-3 self-start rounded-[var(--radius-xl)] p-3">
      <div>
        <Eyebrow className="mb-2 px-1">Live preview</Eyebrow>
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-white/10 bg-black">
          {spec ? (
            <PlayerClient
              key={fetchCount}
              spec={spec}
              paused={railPaused(openSceneIndex)}
              playSignal={playSignal}
            />
          ) : (
            <div className="aspect-[1080/1920] w-full animate-pulse-dot bg-white/[0.03]" />
          )}
        </div>
      </div>
      <div className="content-card px-3 py-2.5">
        <Eyebrow className="mb-1.5">Contract</Eyebrow>
        <div className="font-mono text-[11px] text-ink-secondary">
          {/* The old chip counted FETCHES and reset on reload; this is the real,
              persisted version derived from the assemble patch history (F-5/F-7). */}
          spec.json{meta ? ` · v${meta.specVersion}` : ''}
        </div>
        <div className="mt-1.5 flex gap-1.5">
          <ValidityPill label="pydantic" ok={meta?.pydanticValid} />
          <ValidityPill label="templates" ok={meta?.templatesValid} />
        </div>
      </div>
      {error ? <div className="px-1 font-mono text-[11px] text-warn">{error}</div> : null}
    </aside>
  );
}

/** F-7: a pill is green only when its server-side check PASSED; red when it failed;
 *  muted "·" when meta is unavailable (spawn failed) — never a decorative green. */
function ValidityPill({label, ok}: {label: string; ok: boolean | undefined}) {
  const cls =
    ok === true
      ? 'bg-[rgba(48,209,88,0.15)] text-ok'
      : ok === false
        ? 'bg-[rgba(255,159,10,0.15)] text-warn'
        : 'bg-white/[0.05] text-ink-muted';
  return (
    <span className={`rounded-full px-2 py-[2px] font-mono text-[10px] font-semibold ${cls}`}>
      {label} {ok === true ? '✓' : ok === false ? '✗' : '·'}
    </span>
  );
}

/** Gates call this after an apply that changed spec.json, to refresh the rail. */
export function notifySpecChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio:spec-changed'));
}

/** Ask the rail to play the full assembly once from frame 0 (arrival, ruling 12). */
export function notifyRailPlay() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio:rail-play'));
}
