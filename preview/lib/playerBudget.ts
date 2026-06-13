// Studio v3 M6 — T6 player mount budget.
//
// PRD §5.3 / acceptance: "≤2 players counting MobilePiP". Three @remotion/player
// instances exist in the editing chrome: the desktop rail (PreviewRail), the
// mobile floating PiP (MobilePiP), and the per-scene player in the open accordion
// row. The budget is enforced structurally:
//   • desktop (lg+): rail is always mounted (auto-PAUSED while a row is open); the
//     scene player mounts only in the open row → at most rail + scene = 2.
//   • mobile (<lg): the rail is `lg:block` (not mounted); the PiP UNMOUNTS while a
//     row is open, the scene player takes over → at most 1.
//
// This pure helper is the single source of truth the components and the vitest
// both read, so the assertion can't drift from the wiring.

export type PlayerId = 'rail' | 'pip' | 'scene';

export function mountedPlayers(opts: {
  isDesktop: boolean;
  openSceneIndex: number | null;
}): PlayerId[] {
  const rowOpen = opts.openSceneIndex != null;
  const out: PlayerId[] = [];
  if (opts.isDesktop) {
    out.push('rail'); // persistent; paused (not unmounted) while a row plays
    if (rowOpen) out.push('scene');
  } else {
    if (rowOpen) out.push('scene');
    else out.push('pip');
  }
  return out;
}

/** Whether the mobile PiP should be mounted (it unmounts while a row is open). */
export function shouldMountPiP(openSceneIndex: number | null): boolean {
  return openSceneIndex == null;
}

/** Whether the desktop rail player should be PAUSED (a row is playing its span). */
export function railPaused(openSceneIndex: number | null): boolean {
  return openSceneIndex != null;
}
