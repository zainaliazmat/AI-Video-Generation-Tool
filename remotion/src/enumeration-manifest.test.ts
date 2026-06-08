import {describe, it, expect} from 'vitest';
import manifest from '../../templates/enumeration/manifest.json';

// TS-side view of the plugin contract. We assert manifest.json directly rather
// than importing registry.generated — that pulls in every .tsx Component (React
// JSX runtime) which the pure-logic vitest env doesn't resolve. Registration as a
// `render` entry is covered by build-registry's deterministic output + tsc over
// Video.tsx → registry → Component; the catalog side is covered in pytest.
describe('enumeration manifest (TS contract)', () => {
  it('declares a scene-slot card that owns its text and the routing capability', () => {
    expect(manifest.id).toBe('enumeration');
    expect(manifest.kind).toBe('scene');
    expect(manifest.rendersOwnText).toBe(true);
    expect(manifest.consumes).toBe('enumeration');
  });

  it('generated an items inputSchema (2..6 non-empty labels, no extra keys)', () => {
    const s = manifest.inputSchema as {
      properties: {items: {type: string; minItems: number; maxItems: number}};
      additionalProperties: boolean;
    };
    expect(s.properties.items.type).toBe('array');
    expect(s.properties.items.minItems).toBe(2);
    expect(s.properties.items.maxItems).toBe(6);
    expect(s.additionalProperties).toBe(false);
  });
});
