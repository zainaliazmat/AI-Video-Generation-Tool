'use client';

import {useEffect, useState} from 'react';
import {cn} from '@/lib/cn';
import type {GuideTocSection} from '@/lib/authoring-guide';
import {Eyebrow} from './ui';

/**
 * Sticky table of contents for /templates/guide with scroll-spy: the heading
 * currently in the upper viewport band gets the active accent. Desktop-only
 * (hidden below lg) — on mobile the article reads top-to-bottom.
 */
export function GuideToc({toc}: {toc: GuideTocSection[]}) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const ids = toc.flatMap((s) => [s.id, ...s.children.map((c) => c.id)]);
    const headings = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) setActiveId(visible[0].target.id);
      },
      // Band just below the sticky nav: a heading entering it becomes active.
      {rootMargin: '-64px 0px -75% 0px'},
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [toc]);

  return (
    <nav aria-label="Table of contents" className="hidden lg:block">
      <div className="sticky top-[72px]">
        <Eyebrow>On this page</Eyebrow>
        <ul className="mt-3 flex flex-col gap-[2px] border-l border-white/[0.07]">
          {toc.map((section) => (
            <li key={section.id}>
              <TocLink id={section.id} label={section.label} active={activeId === section.id} />
              {section.children.length > 0 && (
                <ul className="flex flex-col gap-[2px]">
                  {section.children.map((child) => (
                    <li key={child.id}>
                      <TocLink
                        id={child.id}
                        label={child.label}
                        active={activeId === child.id}
                        nested
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function TocLink({
  id,
  label,
  active,
  nested,
}: {
  id: string;
  label: string;
  active: boolean;
  nested?: boolean;
}) {
  return (
    <a
      href={`#${id}`}
      className={cn(
        'focus-ring -ml-px block border-l py-[3px] pr-2 font-ui leading-snug transition-colors duration-150',
        nested ? 'pl-[26px] text-[11.5px]' : 'pl-3.5 text-[12.5px] font-medium',
        active
          ? 'border-accent-1 text-ink'
          : 'border-transparent text-ink-muted hover:text-ink-secondary',
      )}
    >
      {label}
    </a>
  );
}
