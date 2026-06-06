// Pure presentation helpers shared by the gallery client components.

export type BadgeTone = 'green' | 'amber' | 'red' | 'purple' | 'blue' | 'dim';

/** Map a template kind to a Badge tone (consistent color per slot). */
export function kindTone(kind: string): BadgeTone {
  switch (kind) {
    case 'hook':
      return 'blue';
    case 'stat':
      return 'green';
    case 'transition':
      return 'purple';
    case 'overlay':
      return 'amber';
    case 'outro':
      return 'red';
    default:
      return 'dim'; // scene, lower-third
  }
}

export function frameRange(d: {min: number; max: number}): string {
  return `${d.min}–${d.max}f`;
}

export type PropRow = {name: string; type: string; required: boolean};

/** Flatten an inputSchema's top-level properties into a docs table. */
export function propRows(inputSchema: Record<string, unknown>): PropRow[] {
  const props = (inputSchema?.properties as Record<string, unknown>) ?? {};
  const required = (inputSchema?.required as string[]) ?? [];
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type: propType(schema),
    required: required.includes(name),
  }));
}

function propType(schema: unknown): string {
  const s = schema as Record<string, unknown> | undefined;
  if (!s) return 'any';
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Array.isArray(s.anyOf)) return (s.anyOf as unknown[]).map(propType).join(' | ');
  if (Array.isArray(s.type)) return (s.type as string[]).join(' | ');
  return (s.type as string) || 'any';
}
