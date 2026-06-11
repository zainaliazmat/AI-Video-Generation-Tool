'use client';

// Studio v2 — Footage gate route (PRD §8). Surfaces the EXISTING FootageGate
// component at its own /video/[id]/footage route. The persistent live preview is
// rendered by the parent /video/[id] layout (PreviewRail), which refreshes when this
// page dispatches `studio:spec-changed` after an edit — so we don't render a Player
// here, we just notify.

import {useCallback, useEffect, useState} from 'react';
import {useParams} from 'next/navigation';
import {toast} from 'sonner';
import {GateHeader} from '@/components/GateHeader';
import {FootageGate, type GateScene} from '@/components/FootageGate';
import {notifySpecChanged} from '@/components/PreviewRail';
import {studio} from '@/lib/studio';
import {Eyebrow, Badge} from '@/components/ui';

// /state now also returns beatText per scene (and query per candidate). FootageGate's
// GateScene type predates that, so we widen locally — we read beatText for the suggest
// affordance below without touching FootageGate.
type StateScene = GateScene & {beatText?: string | null};

export default function FootagePage() {
  const params = useParams<{id: string}>();
  const id = params.id;

  const [scenes, setScenes] = useState<StateScene[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Per-scene suggested query (from studio.footage.suggest); prefills the re-query box copy.
  const [suggested, setSuggested] = useState<Record<number, string>>({});
  const [suggesting, setSuggesting] = useState<number | null>(null);

  const loadState = useCallback(async () => {
    try {
      const st = await studio.footage.state(id);
      setScenes(Array.isArray(st?.scenes) ? (st.scenes as StateScene[]) : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load footage gate');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  // pick is highlight-only optimistic (mirrors Studio.tsx): the edit response carries the
  // newly-selected rank, so we re-flag in place rather than re-fetching the whole state.
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
      notifySpecChanged(); // refresh the live rail; export MP4 is now stale
      toast.success('Clip swapped — preview updated', {id: toastId, description: 'Re-render to export the MP4.'});
    } catch (e) {
      toast.error('Swap failed', {id: toastId, description: e instanceof Error ? e.message : 'edit failed'});
    } finally {
      setEditing(false);
    }
  }

  // re_query replaces the candidate pool and upload binds an off-pool clip — neither can be
  // re-flagged optimistically, so re-fetch authoritative state, then refresh the rail.
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
      // no content-type header — the browser sets the multipart boundary
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

  // FootageGate has no suggest-query affordance and we may not modify it, so the suggest
  // panel lives here: it asks the backend for a query, then one click re-queries with it.
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
      <GateHeader id={id} gate="footage" />

      {/* Honest-catch caption (PRD §6.4). */}
      <div className="glass mb-4 rounded-xl px-4 py-3">
        <p className="font-ui text-[12px] leading-relaxed text-ink-secondary">
          The pipeline picks rank 1 — you&apos;re the rerank. Hero/stat scenes render as gradient
          cards (no footage by design); this gate doesn&apos;t touch those.
        </p>
      </div>

      {/* Suggest-query helper (studio.footage.suggest). Sits above the existing gate because
          FootageGate exposes no suggest affordance and must not be modified. */}
      {footage.length > 0 && (
        <div className="glass mb-4 rounded-xl p-5">
          <Eyebrow>Suggested queries</Eyebrow>
          <p className="mt-2 font-ui text-[12px] text-ink-muted">
            Stuck on a scene? Ask the pipeline for a fresh Pexels query from the beat text, then
            paste it into the scene&apos;s re-query box below (or use “Use this”).
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {footage.map((s) => (
              <div key={s.index} className="flex flex-wrap items-center gap-2">
                <span className="font-ui text-[12px] text-ink-secondary">Scene {s.index + 1}</span>
                {s.beatText ? (
                  <span className="max-w-[260px] truncate font-ui text-[11px] text-ink-muted" title={s.beatText}>
                    “{s.beatText}”
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
        <div className="glass rounded-xl p-5 font-ui text-[13px] text-ink-muted">Loading footage gate…</div>
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
