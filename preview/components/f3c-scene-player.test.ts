/**
 * F3c: ScenePlayer — per-scene span playback tests.
 *
 * Binding: @remotion/player v4.0.472 supports `inFrame`/`outFrame` natively.
 * ScenePlayer uses:
 *   inFrame={startFrame}
 *   outFrame={startFrame + durationInFrames - 1}   ← INCLUSIVE
 *   initialFrame={startFrame}
 *   durationInFrames={spec.meta.durationInFrames}  ← FULL composition
 *   loop
 *
 * What's testable in node/vitest (no jsdom, no Remotion render):
 *   1. Pure span math helpers (outFrame derivation, boundary assertions).
 *   2. Player prop derivation: verify that the values ScenePlayer would pass
 *      to <Player> satisfy the correctness contract (full duration preserved,
 *      inFrame/outFrame correctly bound to the scene span).
 *   3. Source text assertions that the file passes the right props and does NOT
 *      trim durationInFrames (which would break absolute frame addressing).
 *
 * React render tests (Player mount, loop behaviour in browser) are eyes-on
 * gates during T6 integration.
 */

import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// ─── Pure span math helper ────────────────────────────────────────────────────
// Extracted logic: given (startFrame, durationInFrames), compute the props
// ScenePlayer passes to @remotion/player.

/**
 * Derives the Player span props for a given scene span.
 * Returns the exact values ScenePlayer passes to <Player>.
 */
function deriveSpanProps(
  startFrame: number,
  durationInFrames: number,
  totalFrames: number,
) {
  const outFrame = startFrame + durationInFrames - 1;
  return {
    inFrame: startFrame,
    outFrame,
    initialFrame: startFrame,
    // Full composition duration is always preserved.
    playerDurationInFrames: totalFrames,
  };
}

// ─── Span math: outFrame derivation ──────────────────────────────────────────

describe('ScenePlayer — span math: outFrame derivation', () => {
  it('single-frame scene: outFrame equals startFrame', () => {
    const {inFrame, outFrame} = deriveSpanProps(0, 1, 300);
    expect(inFrame).toBe(0);
    expect(outFrame).toBe(0);
  });

  it('first scene starting at frame 0, 90 frames: outFrame = 89', () => {
    const {inFrame, outFrame} = deriveSpanProps(0, 90, 300);
    expect(inFrame).toBe(0);
    expect(outFrame).toBe(89);
  });

  it('second scene starting at frame 90, 120 frames: outFrame = 209', () => {
    const {inFrame, outFrame} = deriveSpanProps(90, 120, 600);
    expect(inFrame).toBe(90);
    expect(outFrame).toBe(209);
  });

  it('last scene: outFrame must not exceed totalFrames - 1', () => {
    // This is a caller invariant (T6 owns the math), but verify the formula
    // produces totalFrames-1 for a well-formed last scene.
    const totalFrames = 600;
    const startFrame = 510;
    const dur = 90;
    const {outFrame} = deriveSpanProps(startFrame, dur, totalFrames);
    expect(outFrame).toBe(totalFrames - 1);
  });

  it('span with transition overlap (larger durationInFrames): outFrame extends correctly', () => {
    // T6 may pass durationInFrames = scene.durationInFrames + transition.durationInFrames
    // ScenePlayer trusts its props — verify the math still holds.
    const {inFrame, outFrame} = deriveSpanProps(60, 105, 600);
    expect(inFrame).toBe(60);
    expect(outFrame).toBe(164);
    expect(outFrame - inFrame + 1).toBe(105); // span length matches durationInFrames
  });
});

// ─── Span math: loop-boundary equivalents ────────────────────────────────────

describe('ScenePlayer — span length invariant', () => {
  it('span length = outFrame - inFrame + 1 = durationInFrames', () => {
    const cases: Array<[number, number, number]> = [
      [0, 90, 300],
      [90, 120, 600],
      [240, 60, 600],
      [300, 150, 900],
    ];
    for (const [start, dur, total] of cases) {
      const {inFrame, outFrame} = deriveSpanProps(start, dur, total);
      expect(outFrame - inFrame + 1).toBe(dur);
    }
  });

  it('initialFrame always equals inFrame (player opens at scene start)', () => {
    const {inFrame, initialFrame} = deriveSpanProps(150, 90, 600);
    expect(initialFrame).toBe(inFrame);
  });
});

// ─── Full composition duration is never trimmed ───────────────────────────────

describe('ScenePlayer — full composition duration preserved', () => {
  it('playerDurationInFrames always equals spec.meta.durationInFrames', () => {
    const totalFrames = 600;
    const {playerDurationInFrames} = deriveSpanProps(0, 90, totalFrames);
    expect(playerDurationInFrames).toBe(totalFrames);
  });

  it('playerDurationInFrames is independent of scene span', () => {
    const totalFrames = 900;
    const cases: Array<[number, number]> = [
      [0, 90],
      [90, 120],
      [450, 60],
    ];
    for (const [start, dur] of cases) {
      const {playerDurationInFrames} = deriveSpanProps(start, dur, totalFrames);
      expect(playerDurationInFrames).toBe(totalFrames);
    }
  });
});

// ─── Source-text assertions ───────────────────────────────────────────────────
// Verify ScenePlayer.tsx passes the correct props to <Player> and does NOT
// truncate the composition duration (which would break absolute frame addressing).

describe('ScenePlayer.tsx — source-text prop contracts', () => {
  const src = readFileSync(join(__dirname, 'ScenePlayer.tsx'), 'utf8');

  it('passes inFrame={startFrame}', () => {
    expect(src).toContain('inFrame={startFrame}');
  });

  it('passes outFrame computed from startFrame + durationInFrames - 1', () => {
    // The source should compute outFrame as startFrame + durationInFrames - 1
    expect(src).toContain('startFrame + durationInFrames - 1');
    expect(src).toContain('outFrame={outFrame}');
  });

  it('passes initialFrame={startFrame}', () => {
    expect(src).toContain('initialFrame={startFrame}');
  });

  it('uses full composition duration (spec.meta.durationInFrames) for Player durationInFrames', () => {
    // Must NOT pass the scene durationInFrames directly to Player.
    // It must use totalFrames (derived from spec.meta.durationInFrames).
    expect(src).toContain('durationInFrames={totalFrames}');
  });

  it('sets loop prop for span looping', () => {
    expect(src).toContain('loop');
  });

  it('span looping uses inFrame/outFrame + loop, not a manual seekTo loop', () => {
    // The span loop is still the native inFrame/outFrame binding (asserted above).
    // The PlayerRef/seekTo/frameupdate added for the custom control bar drive the
    // scene-relative readout + scrub — they do NOT implement the span loop.
    expect(src).toContain('loop');
    expect(src).toContain('inFrame={startFrame}');
    expect(src).toContain('outFrame={outFrame}');
  });

  it('replaces native controls with a scene-relative custom bar (no 0:42)', () => {
    // Native controls would read the full composition length (e.g. 0:42) with the
    // rest of the bar greyed. We disable them and render a scene-scoped bar: a
    // scene-relative clock + a scrubber scoped to the span.
    expect(src).toContain('controls={false}');
    expect(src).toContain('formatSceneClock');
    expect(src).toContain('clampRelative');
  });
});

// ─── ScenePlayerClient.tsx — ssr:false boundary ──────────────────────────────

describe('ScenePlayerClient.tsx — ssr:false boundary', () => {
  const clientSrc = readFileSync(join(__dirname, 'ScenePlayerClient.tsx'), 'utf8');

  it('uses next/dynamic with ssr:false', () => {
    expect(clientSrc).toContain('ssr: false');
  });

  it('imports ScenePlayer (not VideoPlayer)', () => {
    expect(clientSrc).toContain('./ScenePlayer');
  });

  it('forwards spec, startFrame, durationInFrames, controls props', () => {
    expect(clientSrc).toContain('spec');
    expect(clientSrc).toContain('startFrame');
    expect(clientSrc).toContain('durationInFrames');
    expect(clientSrc).toContain('controls');
  });

  it('has a loading skeleton placeholder', () => {
    expect(clientSrc).toContain('animate-pulse-dot');
  });
});
