'use client';

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {cn} from '@/lib/cn';

const LINKS = [
  {href: '/', label: 'Home'},
  {href: '/templates', label: 'Templates'},
];

/** Slim global top nav: Studio (generate flow) ↔ Templates (gallery). */
export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-20 border-b border-glass bg-black/40 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1040px] items-center gap-1 px-7 py-3 sm:px-8">
        <span className="mr-3 font-ui text-[13px] font-semibold tracking-[-0.01em] text-ink">
          Faceless Video Studio
        </span>
        {LINKS.map((l) => {
          const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                'rounded-[7px] px-3 py-1.5 font-ui text-[13px] font-medium transition-colors duration-150',
                active ? 'bg-white/[0.08] text-ink' : 'text-ink-muted hover:text-ink-secondary',
              )}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
