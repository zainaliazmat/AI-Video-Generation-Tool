// Studio v3 — player mount budget.
//
// The editing chrome has three possible @remotion/player instances: the desktop
// rail (PreviewRail), the floating PiP (FloatingPiP), and the per-scene player in
// the open Scenes accordion row. Since the fixed rail is now reserved for the
// Assemble gate (editing gates use the floating PiP on every viewport), the
// budget collapses to AT MOST ONE mounted player:
//   • Assemble gate, desktop: the full-size rail only (no accordion there → no
//     scene player; the floating PiP is hidden on desktop via hideOnDesktop).
//   • Everywhere else (editing gates any viewport, + mobile Assemble): the
//     floating PiP, which UNMOUNTS while a scene row plays its span (the per-scene
//     player takes over).
//
// This pure helper is the single source of truth the components and the vitest
// both read, so the assertion can't drift from the wiring.

export type PlayerId = 'rail' | 'pip' | 'scene';

export function mountedPlayers(opts: {
  isDesktop: boolean;
  openSceneIndex: number | null;
  onAssemble: boolean;
}): PlayerId[] {
  const rowOpen = opts.openSceneIndex != null;
  // Assemble on desktop is the only place the fixed rail mounts; the floating PiP
  // is hidden there (hideOnDesktop), and there's no accordion → no scene player.
  if (opts.onAssemble && opts.isDesktop) return ['rail'];
  // Editing gates (any viewport) + mobile Assemble: the floating PiP, replaced by
  // the per-scene player while a scene row is open.
  return rowOpen ? ['scene'] : ['pip'];
}

/** Whether the floating PiP should be mounted (it unmounts while a row is open). */
export function shouldMountPiP(openSceneIndex: number | null): boolean {
  return openSceneIndex == null;
}

/** Whether the desktop rail player should be PAUSED. The rail only mounts on the
 *  Assemble gate (no Scenes accordion there), so in practice this stays false;
 *  retained as a guard against any future co-mounted-row scenario. */
export function railPaused(openSceneIndex: number | null): boolean {
  return openSceneIndex != null;
}
