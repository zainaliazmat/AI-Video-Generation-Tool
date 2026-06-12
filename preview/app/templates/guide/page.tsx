import type {Metadata} from 'next';
import Link from 'next/link';
import {loadAuthoringGuide} from '@/lib/authoring-guide';
import {GuideToc} from '@/components/GuideToc';
import {Eyebrow, Badge} from '@/components/ui';

// Read the doc fresh on each request (an edited doc shows up without a
// rebuild — same convention as the gallery's manifest reads).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Template Authoring Guide — Faceless Video Studio',
  description: 'The normative standard for building installable v1 template packages.',
};

// The §7 pipeline, surfaced as a strip so authors see the path before the prose.
const PIPELINE = [
  {
    step: '01',
    name: 'Scaffold',
    cmd: 'npm run new-template',
    blurb: 'Generate a conforming starter — it passes doctor untouched.',
    href: '#step-1-scaffold-optional',
  },
  {
    step: '02',
    name: 'Doctor',
    cmd: 'install.mjs doctor <dir>',
    blurb: 'Dry-run every install stage. Fix every error before moving on.',
    href: '#step-2-doctor',
  },
  {
    step: '03',
    name: 'Pack',
    cmd: 'install.mjs pack <dir>',
    blurb: 'Zip the package. Pack refuses a template that fails doctor.',
    href: '#step-3-pack',
  },
  {
    step: '04',
    name: 'Install',
    cmd: 'Templates → Install',
    blurb: 'Drag the zip into the Studio dropzone, or submit it to the marketplace.',
    href: '#step-4-install-or-submit',
  },
];

export default function TemplateGuidePage() {
  const {html, toc} = loadAuthoringGuide();

  return (
    <main className="relative z-[1] mx-auto max-w-[1120px] px-7 py-10 sm:px-8 sm:py-12">
      {/* Breadcrumb back to the gallery */}
      <Link
        href="/templates"
        className="focus-ring inline-flex items-center gap-1.5 rounded-[7px] font-ui text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink-secondary"
      >
        ← Template library
      </Link>

      {/* Hero */}
      <header className="mt-7">
        <Eyebrow>Authoring kit</Eyebrow>
        <h1 className="mt-2 font-ui text-[clamp(28px,4vw,40px)] font-semibold leading-[1.08] tracking-[-0.03em] text-ink">
          Template Authoring Guide
        </h1>
        <p className="mt-3 max-w-[58ch] font-ui text-[14px] leading-relaxed text-ink-secondary">
          The normative standard for building installable template packages — every rule the
          installer enforces, from the manifest contract to the frozen import surface. If your
          template passes <code className="font-mono text-[13px]">doctor</code>, it installs
          byte-for-byte.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="purple">Normative · v1</Badge>
          <Badge tone="blue">doctor = install, dry-run</Badge>
          <Badge tone="green">Scaffold passes untouched</Badge>
        </div>
      </header>

      {/* Pipeline strip: scaffold → doctor → pack → install */}
      <ol className="mt-9 grid list-none grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PIPELINE.map((stage) => (
          <li key={stage.step}>
            <a
              href={stage.href}
              className="focus-ring glass glass-hover block h-full rounded-[14px] p-4 transition-transform duration-150 hover:-translate-y-px"
            >
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[11px] font-medium text-accent-3">
                  {stage.step}
                </span>
                <span className="font-mono text-[10px] text-ink-muted">
                  {stage.step !== '04' ? '→' : '✓'}
                </span>
              </div>
              <div className="mt-2 font-ui text-[14px] font-semibold tracking-[-0.01em] text-ink">
                {stage.name}
              </div>
              <div className="mt-1 font-mono text-[10.5px] text-ink-muted">{stage.cmd}</div>
              <p className="mt-2 font-ui text-[11.5px] leading-[1.55] text-ink-secondary">
                {stage.blurb}
              </p>
            </a>
          </li>
        ))}
      </ol>

      {/* TOC + article */}
      <div className="mt-12 grid gap-12 lg:grid-cols-[228px_minmax(0,1fr)]">
        <GuideToc toc={toc} />
        {/* Trusted source: our own repo doc, rendered server-side. */}
        <article className="guide-prose min-w-0" dangerouslySetInnerHTML={{__html: html}} />
      </div>
    </main>
  );
}
