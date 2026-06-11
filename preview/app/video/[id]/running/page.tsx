'use client';

import {useEffect, useState} from 'react';
import Link from 'next/link';
import {useParams} from 'next/navigation';
import {studio} from '@/lib/studio';
import {Eyebrow} from '@/components/ui';
import {TintedButton} from '@/components/GateHeader';
import {PipelineStepper} from '@/components/PipelineStepper';

// Studio v2 Running page (PRD §5). The primary generate flow is kicked from Home and
// streams its stepper there, then routes straight into the hub — so this page only
// matters when someone lands on /video/[id]/running directly. We probe whether the
// project exists: if it does, generation already finished → offer the hub; if not,
// show an idle stepper placeholder and a way back home.
type Phase = 'checking' | 'ready' | 'missing';

export default function RunningPage() {
  const params = useParams();
  const id = String(params.id);
  const [phase, setPhase] = useState<Phase>('checking');

  useEffect(() => {
    let alive = true;
    studio
      .project(id)
      .then(() => alive && setPhase('ready'))
      .catch(() => alive && setPhase('missing'));
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="content-card p-6">
      {phase === 'checking' ? (
        <>
          <Eyebrow className="mb-2">Checking project…</Eyebrow>
          <div className="mt-4 px-1 opacity-50">
            <PipelineStepper />
          </div>
        </>
      ) : phase === 'ready' ? (
        <>
          <Eyebrow className="mb-2 text-ok">Generation complete</Eyebrow>
          <p className="font-ui text-[14px] leading-relaxed text-ink-secondary">
            This video is ready to tune. Open the hub to review the script, voice,
            footage, and assemble gates.
          </p>
          <div className="mt-5">
            <Link href={`/video/${id}`}>
              <TintedButton>Open the hub →</TintedButton>
            </Link>
          </div>
        </>
      ) : (
        <>
          <Eyebrow className="mb-2 text-warn">No project here yet</Eyebrow>
          <p className="font-ui text-[14px] leading-relaxed text-ink-secondary">
            Generation is kicked from the home screen. Start a new video there and you’ll
            be brought straight to the editing hub when it finishes.
          </p>
          <div className="mt-4 px-1 opacity-50">
            <PipelineStepper />
          </div>
          <div className="mt-5">
            <Link href="/">
              <TintedButton>Go to Home →</TintedButton>
            </Link>
          </div>
        </>
      )}
      <p className="mt-5 font-ui text-[12px] text-ink-muted">
        Runs entirely on your machine — no per-video API cost, just CPU time.
      </p>
    </div>
  );
}
