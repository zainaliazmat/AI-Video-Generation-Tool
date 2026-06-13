'use client';

// Studio v3 M6 — T9 §4.1 edit-intent guard.
//
// At a COMPLETED gate, the FIRST edit intent opens the BlastRadiusSheet with the
// POST withheld (ruling D2/D3): Cancel discards with ZERO backend traffic; Reopen
// fires the withheld edit (the backend's gatekeeper.edit reopens the gate + defers
// the rederive — M1 amend 1). After the gate is reopened, further edits accumulate
// silently (no sheet) until the amber Re-approve pays once.
//
// Discriminator: only state==='approved' triggers the sheet. A frontier gate
// (awaiting, no stamp) edits instantly; a reopened gate (awaiting + approved_at,
// surfaced as 'reopened') already accumulates.

import {useCallback, useState} from 'react';
import {BlastRadiusSheet} from '@/components/BlastRadiusSheet';
import type {Gate} from '@/lib/studio';

export function useEditIntent({
  sid,
  gate,
  gateState,
}: {
  sid: string;
  gate: 'script' | 'voice' | 'scenes' | 'assemble';
  gateState: Gate | undefined;
}) {
  const [pending, setPending] = useState<(() => void | Promise<void>) | null>(null);
  // Local latch so rapid edits after the first Reopen don't re-sheet before the
  // context's gate state catches up to 'reopened'.
  const [reopenedLocally, setReopenedLocally] = useState(false);

  const needsSheet = gateState?.state === 'approved' && !reopenedLocally;

  const intend = useCallback(
    (apply: () => void | Promise<void>) => {
      if (needsSheet) setPending(() => apply);
      else void apply();
    },
    [needsSheet],
  );

  const sheet = (
    <BlastRadiusSheet
      open={pending !== null}
      gate={gate}
      sid={sid}
      onReopen={() => {
        const fn = pending;
        setPending(null);
        setReopenedLocally(true);
        if (fn) void fn();
      }}
      onCancel={() => setPending(null)}
    />
  );

  return {intend, sheet};
}
