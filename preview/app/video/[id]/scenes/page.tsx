'use client';

// Studio v3 M6 — /video/[id]/scenes — WORKING STUB (F3a).
//
// This stub exists so the /scenes route is reachable — it lets T11 flip
// GateHeader's CHAIN to include 'scenes' without a 404.  The full scene-major
// accordion is built in T5 (the real implementation).
//
// For now this page renders the EXISTING footage-gate experience:
//   - Fetches studio.footage.state(id) (typed SessionState via studio.session.state)
//   - Renders the current FootageGate component wrapped in a GateHeader
//
// NOTE: GateHeader's CHAIN still lists 'footage' (not 'scenes') until T11.
//       We pass gate="footage" here because 'scenes' is not yet in the CHAIN
//       type — a TODO is left in place.
//
// /footage is NOT deleted or redirected — it remains at its current route and
// must continue to work untouched.

import {useCallback, useEffect, useState} from 'react';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {GateHeader} from '@/components/GateHeader';
import {FootageGate, type GateScene} from '@/components/FootageGate';
import {notifySpecChanged} from '@/components/PreviewRail';
import {studio} from '@/lib/studio';
import {Eyebrow, Badge} from '@/components/ui';

// /state returns beatText per scene; widen locally (same pattern as footage/page.tsx)
type StateScene = GateScene & {beatText?: string | null};

export default function ScenesPage() {
  const params = useParams<{id: string}>();
  const id = params.id;

  const [scenes, setScenes] = useState<StateScene[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [suggested, setSuggested] = useState<Record<number, string>>({});
  const [suggesting, setSuggesting] = useState<number | null>(null);

  const loadState = useCallback(async () => {
    try {
      const st = await studio.footage.state(id);
      setScenes(Array.isArray(st?.scenes) ? (st.scenes as StateScene[]) : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load scenes gate');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  async function pick(scene: number, rank: number) {
    if (editing) return;
    setEditing(true);
    const toastId = toast.loading('Swapping clip…');
    try {
      const res = await fetch(`/api/session/${id}/edit`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({op: 'pick', scene, rank}),
      });
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setScenes((prev) =>
        prev.map((s) =>
          s.index === json.scene
            ? {...s, candidates: s.candidates.map((c) => ({...c, selected: c.rank === json.selectedRank}))}
            : s,
        ),
      );
      notifySpecChanged();
      toast.success('Clip swapped — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Swap failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

  async function refreshAfterEdit() {
    await loadState();
    notifySpecChanged();
  }

  async function reQuery(scene: number, query: string) {
    if (editing) return;
    setEditing(true);
    const toastId = toast.loading('Re-querying footage…');
    try {
      const res = await fetch(`/api/session/${id}/edit`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({op: 're_query', scene, query}),
      });
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      await refreshAfterEdit();
      toast.success('Footage re-queried — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Re-query failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

  async function upload(scene: number, file: File) {
    if (editing) return;
    setEditing(true);
    const toastId = toast.loading('Uploading footage…');
    try {
      const form = new FormData();
      form.append('op', 'upload');
      form.append('scene', String(scene));
      form.append('file', file);
      const res = await fetch(`/api/session/${id}/edit`, {method: 'POST', body: form});
      if (res.status === 409) {
        toast.error('An edit is already in progress', {id: toastId});
        return;
      }
      const json = await res.json();
      if (!res.ok || json?.ok === false) throw new Error(json?.error ?? `HTTP ${res.status}`);
      await refreshAfterEdit();
      toast.success('Upload bound — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Upload failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

  async function suggest(scene: number) {
    if (editing || suggesting !== null) return;
    setSuggesting(scene);
    try {
      const r = await studio.footage.suggest(id, scene);
      if (!r?.query) throw new Error('no query suggested');
      setSuggested((prev) => ({...prev, [scene]: r.query}));
    } catch (e) {
      toast.error('Suggest failed', {description: e instanceof Error ? e.message : 'suggest failed'});
    } finally {
      setSuggesting(null);
    }
  }

  const footage = scenes.filter((s) => s.needsFootage);

  return (
    <div>
      {/* TODO(T11): update GateHeader's CHAIN type to include 'scenes' then change
          gate prop from "footage" to "scenes". For now 'footage' is used because
          GateHeader's const CHAIN doesn't know 'scenes' yet. */}
      <GateHeader id={id} gate="footage" />

      {/* Stub notice (scenes accordion — full build in T5) */}
      <div className="glass mb-4 rounded-xl px-4 py-3">
        <p className="font-ui text-[12px] font-semibold leading-relaxed text-warn">
          scenes accordion — full build in T5
        </p>
        <p className="mt-1 font-ui text-[12px] leading-relaxed text-ink-secondary">
          This route stub renders the existing footage-gate experience. The v3 scene-major
          accordion (one row per scene with StatusPills, per-scene player, template + transition
          controls) is built in T5. The /footage route remains untouched at its own URL.
        </p>
      </div>

      {/* Suggest-query helper (mirrors footage/page.tsx exactly) */}
      {footage.length > 0 && (
        <div className="glass mb-4 rounded-xl p-5">
          <Eyebrow>Suggested queries</Eyebrow>
          <p className="mt-2 font-ui text-[12px] text-ink-muted">
            Stuck on a scene? Ask the pipeline for a fresh Pexels query from the beat text.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {footage.map((s) => (
              <div key={s.index} className="flex flex-wrap items-center gap-2">
                <span className="font-ui text-[12px] text-ink-secondary">Scene {s.index + 1}</span>
                {s.beatText ? (
                  <span className="max-w-[260px] truncate font-ui text-[11px] text-ink-muted" title={s.beatText}>
                    &ldquo;{s.beatText}&rdquo;
                  </span>
                ) : null}
                <button
                  onClick={() => suggest(s.index)}
                  disabled={editing || suggesting !== null}
                  className="shrink-0 rounded-md border border-white/10 px-2.5 py-1.5 font-ui text-[12px] text-ink-secondary transition hover:border-white/30 hover:text-ink disabled:opacity-40"
                >
                  {suggesting === s.index ? 'Suggesting…' : 'Suggest query'}
                </button>
                {suggested[s.index] ? (
                  <>
                    <Badge tone="purple">{suggested[s.index]}</Badge>
                    <button
                      onClick={() => reQuery(s.index, suggested[s.index])}
                      disabled={editing}
                      className="shrink-0 rounded-md border border-white/10 px-2.5 py-1.5 font-ui text-[12px] text-ink-secondary transition hover:border-white/30 hover:text-ink disabled:opacity-40"
                    >
                      Use this →
                    </button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="glass rounded-xl p-5 font-ui text-[13px] text-ink-muted">Loading scenes gate…</div>
      ) : error ? (
        <div className="glass rounded-xl p-5 font-ui text-[13px] text-warn">{error}</div>
      ) : footage.length === 0 ? (
        <div className="glass rounded-xl p-5 font-ui text-[13px] text-ink-muted">
          No footage scenes in this video — every scene renders as a gradient card.
        </div>
      ) : (
        <FootageGate scenes={scenes} busy={editing} onPick={pick} onRequery={reQuery} onUpload={upload} />
      )}
    </div>
  );
}
