import {describe, it, expect} from 'vitest';
import {schema} from '../../templates/enumeration/schema';

describe('enumeration inputSchema (zod source of truth)', () => {
  it('accepts a 2..6 item set of non-empty labels', () => {
    expect(schema.safeParse({items: ['Sun', 'Moon']}).success).toBe(true);
    expect(schema.safeParse({items: ['Sun', 'Moon', 'Planets', 'Eclipse', 'Phases']}).success).toBe(true);
  });
  it('rejects <2, >6, empty labels, and extra keys', () => {
    expect(schema.safeParse({items: ['Sun']}).success).toBe(false);
    expect(schema.safeParse({items: ['a', 'b', 'c', 'd', 'e', 'f', 'g']}).success).toBe(false);
    expect(schema.safeParse({items: ['Sun', '']}).success).toBe(false);
    expect(schema.safeParse({items: ['Sun', 'Moon'], icon: 'x'}).success).toBe(false);
  });
});
