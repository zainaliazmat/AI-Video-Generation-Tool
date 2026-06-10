import React from 'react';
import {icons} from 'lucide-react';
import type {LucideName} from './media';
import {toPascal} from './media';

/**
 * Tintable lucide icon by name. lucide-react exposes a name->component registry as
 * `icons` with PascalCase keys; toPascal (shared with the registry test) maps our
 * kebab `LucideName` to that. `color` drives the stroke (currentColor under the
 * hood) so the theme palette tints it. Falls back to an empty box if a name is
 * somehow absent — but the registry-coverage test guarantees that never happens
 * for any ICON_MAP value, so this is belt-and-suspenders only.
 */
export const LucideGlyph: React.FC<{name: LucideName; size: number; color: string}> = ({
  name,
  size,
  color,
}) => {
  const Cmp = (icons as Record<string, React.ComponentType<{size: number; color: string; strokeWidth: number}>>)[
    toPascal(name)
  ];
  if (!Cmp) return <span style={{width: size, height: size, display: 'inline-block'}} />;
  return <Cmp size={size} color={color} strokeWidth={1.75} />;
};
