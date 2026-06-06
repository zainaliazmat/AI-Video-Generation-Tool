'use client';

import {useState} from 'react';
import {Badge} from './ui';
import {kindTone, frameRange} from '@/lib/template-ui';
import type {TemplateMeta} from '@/lib/templates';

/**
 * A gallery card. POSTER-FIRST: the static poster shows by default and the MP4
 * is only mounted/played on hover (so the grid never autoplays N clips at once,
 * and stays snappy as the library grows). Click opens the detail drawer.
 */
export function TemplateCard({template, onOpen}: {template: TemplateMeta; onOpen: () => void}) {
  const [hover, setHover] = useState(false);
  const t = template;

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group glass glass-hover overflow-hidden rounded-xl text-left transition-transform duration-150 hover:-translate-y-0.5"
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-black">
        {hover && t.mp4 ? (
          <video
            src={t.mp4}
            poster={t.poster ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            className="h-full w-full object-cover"
          />
        ) : t.poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.poster} alt={t.name} loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-4 text-center font-ui text-[12px] text-ink-muted">
            preview pending
            <br />
            (run gen-previews)
          </div>
        )}
        {t.mp4 && (
          <div className="pointer-events-none absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 font-mono text-[10px] text-white/80 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            ▶ loop
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-ui text-[13px] font-medium text-ink">{t.name}</div>
          <div className="mt-0.5 font-mono text-[10.5px] tabular-nums text-ink-muted">
            {frameRange(t.durationFrames)}
          </div>
        </div>
        <Badge tone={kindTone(t.kind)}>{t.kind}</Badge>
      </div>
    </button>
  );
}
