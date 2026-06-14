import {describe, expect, it} from 'vitest';
import {mountedPlayers, shouldMountPiP, railPaused, type PlayerId} from './playerBudget';

// Mount budget: with the fixed rail reserved for Assemble and the floating PiP
// everywhere else, never more than ONE @remotion/player instance is mounted.
describe('mountedPlayers — ≤1 budget', () => {
  const cases: {isDesktop: boolean; openSceneIndex: number | null; onAssemble: boolean}[] = [
    {isDesktop: true, openSceneIndex: null, onAssemble: false},
    {isDesktop: true, openSceneIndex: 0, onAssemble: false},
    {isDesktop: true, openSceneIndex: 3, onAssemble: false},
    {isDesktop: false, openSceneIndex: null, onAssemble: false},
    {isDesktop: false, openSceneIndex: 0, onAssemble: false},
    {isDesktop: true, openSceneIndex: null, onAssemble: true},
    {isDesktop: false, openSceneIndex: null, onAssemble: true},
  ];

  it('never mounts more than one player in any state', () => {
    for (const c of cases) {
      expect(mountedPlayers(c).length).toBeLessThanOrEqual(1);
    }
  });

  it('Assemble + desktop → the full-size rail only', () => {
    expect(mountedPlayers({isDesktop: true, openSceneIndex: null, onAssemble: true})).toEqual<PlayerId[]>(['rail']);
  });

  it('Assemble + mobile → the floating PiP (rail is desktop-only)', () => {
    expect(mountedPlayers({isDesktop: false, openSceneIndex: null, onAssemble: true})).toEqual<PlayerId[]>(['pip']);
  });

  it('editing gate, no row open → the floating PiP on every viewport', () => {
    expect(mountedPlayers({isDesktop: true, openSceneIndex: null, onAssemble: false})).toEqual<PlayerId[]>(['pip']);
    expect(mountedPlayers({isDesktop: false, openSceneIndex: null, onAssemble: false})).toEqual<PlayerId[]>(['pip']);
  });

  it('scenes gate, row open → the per-scene player only (PiP unmounts), any viewport', () => {
    expect(mountedPlayers({isDesktop: true, openSceneIndex: 1, onAssemble: false})).toEqual<PlayerId[]>(['scene']);
    expect(mountedPlayers({isDesktop: false, openSceneIndex: 0, onAssemble: false})).toEqual<PlayerId[]>(['scene']);
  });
});

describe('shouldMountPiP / railPaused', () => {
  it('PiP unmounts while a row is open', () => {
    expect(shouldMountPiP(null)).toBe(true);
    expect(shouldMountPiP(0)).toBe(false);
    expect(shouldMountPiP(5)).toBe(false);
  });

  it('railPaused tracks an open row (a no-op on Assemble, where no row exists)', () => {
    expect(railPaused(null)).toBe(false);
    expect(railPaused(0)).toBe(true);
    expect(railPaused(2)).toBe(true);
  });
});
