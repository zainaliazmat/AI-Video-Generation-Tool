import {describe, expect, it} from 'vitest';
import {mountedPlayers, shouldMountPiP, railPaused, type PlayerId} from './playerBudget';

// T6 mount budget: never more than two @remotion/player instances mounted at once,
// counting the MobilePiP (PRD §5.3 acceptance).
describe('mountedPlayers — ≤2 budget', () => {
  const cases: {isDesktop: boolean; openSceneIndex: number | null}[] = [
    {isDesktop: true, openSceneIndex: null},
    {isDesktop: true, openSceneIndex: 0},
    {isDesktop: true, openSceneIndex: 3},
    {isDesktop: false, openSceneIndex: null},
    {isDesktop: false, openSceneIndex: 0},
    {isDesktop: false, openSceneIndex: 2},
  ];

  it('never mounts more than two players in any state', () => {
    for (const c of cases) {
      expect(mountedPlayers(c).length).toBeLessThanOrEqual(2);
    }
  });

  it('desktop, no row open → rail only', () => {
    expect(mountedPlayers({isDesktop: true, openSceneIndex: null})).toEqual(['rail']);
  });

  it('desktop, row open → rail (paused) + scene', () => {
    const m = mountedPlayers({isDesktop: true, openSceneIndex: 1});
    expect(m).toEqual<PlayerId[]>(['rail', 'scene']);
  });

  it('mobile, no row open → pip only', () => {
    expect(mountedPlayers({isDesktop: false, openSceneIndex: null})).toEqual(['pip']);
  });

  it('mobile, row open → scene only (pip unmounts)', () => {
    expect(mountedPlayers({isDesktop: false, openSceneIndex: 0})).toEqual(['scene']);
  });
});

describe('shouldMountPiP / railPaused', () => {
  it('PiP unmounts while a row is open', () => {
    expect(shouldMountPiP(null)).toBe(true);
    expect(shouldMountPiP(0)).toBe(false);
    expect(shouldMountPiP(5)).toBe(false);
  });

  it('rail pauses while a row is open', () => {
    expect(railPaused(null)).toBe(false);
    expect(railPaused(0)).toBe(true);
    expect(railPaused(2)).toBe(true);
  });
});
