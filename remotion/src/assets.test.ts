import {describe, expect, it} from 'vitest';
import {resolveAssets} from './assets';
import type {Manifest} from '../../templates/sdk';

const base: Manifest = {
  id: 'demo', name: 'Demo', version: '1.0.0', author: 'acme', apiVersion: '1',
  kind: 'scene', inputSchema: {}, sampleProps: {}, durationFrames: {min: 30, max: 120},
};

describe('resolveAssets', () => {
  // R1 (§15.14): a template with NO manifest.assets gets exactly {} — identical
  // to the literal `assets={{}}` both harnesses passed before the resolver.
  it('returns {} when manifest.assets is absent', () => {
    expect(resolveAssets(base)).toEqual({});
  });
  it('returns {} when manifest.assets is empty', () => {
    expect(resolveAssets({...base, assets: []})).toEqual({});
  });
  it('maps each declared relPath to its namespaced staticFile URL', () => {
    const r = resolveAssets({...base, assets: ['assets/underline.svg', 'assets/img/bg.png']});
    expect(Object.keys(r)).toEqual(['assets/underline.svg', 'assets/img/bg.png']);
    expect(r['assets/underline.svg']).toContain('template-assets/demo/underline.svg');
    expect(r['assets/img/bg.png']).toContain('template-assets/demo/img/bg.png');
  });
});
