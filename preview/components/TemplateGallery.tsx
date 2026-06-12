'use client';

import {useMemo, useState} from 'react';
import {motion} from 'framer-motion';
import {cn} from '@/lib/cn';
import {Eyebrow} from './ui';
import {TemplateCard} from './TemplateCard';
import {TemplateDrawer} from './TemplateDrawer';
import type {TemplateMeta} from '@/lib/templates';
import type {UnifiedItem} from '@/lib/marketplace-ui';

const KIND_ORDER = ['hook', 'scene', 'stat', 'lower-third', 'transition', 'overlay', 'outro'];

/** Task-2 bag passed down from the server page; consumed fully in Task 3. */
export interface GalleryBag {
  installed: UnifiedItem[];
  catalog: UnifiedItem[];
  installedIds: string[];
}

export function TemplateGallery({templates, galleryBag: _galleryBag}: {templates: TemplateMeta[]; galleryBag?: GalleryBag}) {
  const [filter, setFilter] = useState<string>('all');
  const [selected, setSelected] = useState<TemplateMeta | null>(null);

  const kinds = useMemo(() => {
    const present = [...new Set(templates.map((t) => t.kind))];
    return present.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
  }, [templates]);

  const shown = filter === 'all' ? templates : templates.filter((t) => t.kind === filter);
  const missing = templates.filter((t) => !t.mp4).length;

  return (
    <main className="relative z-[1] mx-auto max-w-[1040px] px-7 py-10 sm:px-8 sm:py-12">
      <motion.header initial={{opacity: 0, y: 12}} animate={{opacity: 1, y: 0}} transition={{type: 'spring', stiffness: 300, damping: 30}}>
        <Eyebrow>Template library</Eyebrow>
        <h1 className="mt-2 font-ui text-[clamp(28px,4vw,40px)] font-semibold leading-[1.08] tracking-[-0.03em] text-ink">
          {templates.length} drop-in templates
        </h1>
        <p className="mt-3 max-w-[56ch] font-ui text-[14px] leading-relaxed text-ink-secondary">
          Every template discovered in <code className="font-mono text-[13px]">templates/</code>, each with a preview
          auto-rendered from its sample props. Click a card for its input contract.
          {missing > 0 && (
            <span className="text-ink-muted">
              {' '}
              ({missing} preview{missing > 1 ? 's' : ''} not generated — run{' '}
              <code className="font-mono text-[13px]">npm run gen-previews</code>.)
            </span>
          )}
        </p>
      </motion.header>

      {/* Kind filter pills */}
      <div className="mt-7 flex flex-wrap gap-2">
        <FilterPill label="All" active={filter === 'all'} onClick={() => setFilter('all')} />
        {kinds.map((k) => (
          <FilterPill key={k} label={k} active={filter === k} onClick={() => setFilter(k)} />
        ))}
      </div>

      {/* Grid */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
        {shown.map((t) => (
          <TemplateCard key={t.id} template={t} onOpen={() => setSelected(t)} />
        ))}
      </div>

      <TemplateDrawer template={selected} onClose={() => setSelected(null)} />
    </main>
  );
}

function FilterPill({label, active, onClick}: {label: string; active: boolean; onClick: () => void}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-3.5 py-1.5 font-ui text-[12.5px] font-medium capitalize transition-colors duration-150',
        active ? 'bg-white/[0.12] text-ink' : 'glass glass-hover text-ink-secondary',
      )}
    >
      {label}
    </button>
  );
}
