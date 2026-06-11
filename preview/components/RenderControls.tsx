'use client';

import {useState} from 'react';
import {toast} from 'sonner';
import type {Spec} from '@remotion-src/schema';
import {Badge, Button, ProgressBar} from './ui';

type Status = 'idle' | 'rendering' | 'done' | 'error';

export function RenderControls({
  spec,
  projectId,
  onRendered,
}: {
  spec: Spec;
  projectId: string;
  onRendered: () => void;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [frame, setFrame] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);

  async function render() {
    setStatus('rendering');
    setProgress(0);
    setFrame(0);
    setError(null);
    setOutputUrl(null);
    const toastId = toast.loading('Rendering video…');

    try {
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({id: projectId}),
      });
      if (res.status === 409) {
        toast.error('A render is already in progress', {id: toastId});
        setStatus('idle');
        return;
      }
      if (!res.ok || !res.body) {
        throw new Error(`Render request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false; // local terminal flag — `status` would be a stale closure

      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const f of frames) {
          const line = f.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let msg: {type: string; [k: string]: unknown};
          try {
            msg = JSON.parse(line.slice(6));
          } catch {
            continue; // skip a malformed SSE frame rather than failing the render
          }
          if (msg.type === 'progress') {
            setProgress(msg.progress as number);
            setFrame(msg.frame as number);
          } else if (msg.type === 'done') {
            finished = true;
            const url = `/api/projects/${projectId}/video?t=${Date.now()}`;
            setProgress(1);
            setStatus('done');
            setOutputUrl(url);
            toast.success('Render complete', {id: toastId});
            onRendered();
          } else if (msg.type === 'error') {
            finished = true;
            throw new Error(String(msg.message));
          }
        }
      }
      // Stream ended without an explicit done/error.
      if (!finished) {
        setStatus('idle');
        toast.dismiss(toastId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Render failed';
      setError(message);
      setStatus('error');
      toast.error('Render failed', {id: toastId, description: message});
    }
  }

  const busy = status === 'rendering';

  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-ui text-[13.5px] font-semibold text-ink">Export</span>
          {status === 'idle' && <Badge tone="dim">Ready</Badge>}
          {status === 'rendering' && (
            <Badge tone="blue" dot>
              Rendering
            </Badge>
          )}
          {status === 'done' && (
            <Badge tone="green" dot>
              Done
            </Badge>
          )}
          {status === 'error' && (
            <Badge tone="red" dot>
              Failed
            </Badge>
          )}
        </div>
        <Button onClick={render} disabled={busy}>
          {busy ? `Rendering ${Math.round(progress * 100)}%` : 'Render MP4'}
        </Button>
      </div>

      {busy && (
        <div className="mt-4">
          <ProgressBar value={progress} />
          <div className="mt-2 font-mono text-[11px] tabular-nums text-ink-muted">
            frame {frame} / {spec.meta.durationInFrames} · 1080×1920 · h264
          </div>
        </div>
      )}

      {status === 'error' && error && (
        <p className="mt-3 font-mono text-[12px] text-[#f87171]">{error}</p>
      )}

      {status === 'done' && outputUrl && (
        <div className="mt-4 flex flex-col gap-3">
          <video
            src={outputUrl}
            controls
            className="w-full max-w-[220px] rounded-[var(--radius-md)] border border-glass"
          />
          <a
            href={outputUrl}
            download="video.mp4"
            className="inline-flex w-fit items-center gap-2 rounded-[8px] border border-glass bg-white/[0.04] px-4 py-2 font-ui text-[13px] text-ink transition-colors duration-150 hover:bg-white/[0.07]"
          >
            ↓ Download MP4
          </a>
        </div>
      )}
    </div>
  );
}
