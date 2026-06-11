import {describe, it, expect} from 'vitest';
import {icons} from 'lucide-react';
import {ICON_MAP, toPascal} from '../../templates/enumeration/media';

describe('lucide registry coverage', () => {
  it('every ICON_MAP name resolves to a real lucide component (no silent invisible icons)', () => {
    const unresolved = Object.values(ICON_MAP).filter((name) => !(toPascal(name) in icons));
    expect(unresolved).toEqual([]);
  });
});
