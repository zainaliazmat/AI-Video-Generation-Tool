import {describe, expect, it} from 'vitest';
import {currentGateFromPath} from './VideoChrome';

// VideoChrome derives the active gate from the pathname to decide whether to
// mount the floating GateStepper (gate pages only) and how much top padding the
// content needs. The hub / running / non-gate routes must yield null.
describe('currentGateFromPath', () => {
  it('returns the gate segment on a /video/[id]/<gate> path', () => {
    expect(currentGateFromPath('/video/abc/script')).toBe('script');
    expect(currentGateFromPath('/video/abc/voice')).toBe('voice');
    expect(currentGateFromPath('/video/abc/scenes')).toBe('scenes');
    expect(currentGateFromPath('/video/abc/assemble')).toBe('assemble');
  });

  it('returns null on the hub (no gate segment)', () => {
    expect(currentGateFromPath('/video/abc')).toBeNull();
  });

  it('returns null on non-gate sub-routes', () => {
    expect(currentGateFromPath('/video/abc/running')).toBeNull();
    expect(currentGateFromPath('/video/abc/footage')).toBeNull();
  });

  it('returns null off the /video segment entirely', () => {
    expect(currentGateFromPath('/')).toBeNull();
    expect(currentGateFromPath('/templates')).toBeNull();
    expect(currentGateFromPath(null)).toBeNull();
  });

  it('tolerates a trailing slash / deeper segments by reading index 3 only', () => {
    expect(currentGateFromPath('/video/abc/script/')).toBe('script');
    expect(currentGateFromPath('/video/abc/scenes/2')).toBe('scenes');
  });
});
