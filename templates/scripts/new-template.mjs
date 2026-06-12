#!/usr/bin/env node
// new-template.mjs — scaffold a conforming template starter (§9.2).
//
// Usage:
//   node scripts/new-template.mjs --id <id> --kind <kind> [--dir <out>]
//
// Writes a working starter at <out>/<id>/ that passes `doctor` untouched:
//   - manifest.json (v1.1 fields, baked inputSchema)
//   - schema.ts (content kinds only: one prop, z.string())
//   - Component.tsx (content kinds: theme tokens + frame-driven entrance + fail-closed)
//   OR presentation.tsx (transition: remotion-primitive factory)
//   - README.md
//
// The inputSchema in manifest.json is BAKED LITERALLY — the scaffold's zod schema is
// fixed ({title: z.string()}).strict(), which gen-manifests deterministically produces:
//   {"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}
// This guarantees stage-5 schema-diff passes without re-running gen-manifests from an
// arbitrary output dir (the M3 lesson: tsx needs node_modules up the chain).
//
// After writing, prints next-steps (doctor + pack commands).

import {mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Legal kinds (§1.2 / sdk.ts TemplateKind)
// ---------------------------------------------------------------------------

const CONTENT_KINDS = new Set(['hook', 'scene', 'stat', 'lower-third', 'overlay', 'outro']);
const TRANSITION_KIND = 'transition';
const ALL_KINDS = [...CONTENT_KINDS, TRANSITION_KIND];

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const id = get('--id');
  const kind = get('--kind');
  const dir = get('--dir');
  return {id, kind, dir};
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/new-template.mjs --id <id> --kind <kind> [--dir <out>]\n\n' +
      `  --id    Template id (^[a-z][a-z0-9-]{1,40}$)\n` +
      `  --kind  One of: ${ALL_KINDS.join(', ')}\n` +
      `  --dir   Output directory (default: current working directory)\n`,
  );
}

// ---------------------------------------------------------------------------
// Id validation (mirrors _isValidId in install-stages.mjs)
// ---------------------------------------------------------------------------

function isValidId(id) {
  if (typeof id !== 'string') return false;
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) return false;
  if (id === 'scripts' || id === 'node_modules') return false;
  if (id.startsWith('.')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Title-case helper
// ---------------------------------------------------------------------------

function toTitleCase(id) {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Baked inputSchema for the fixed scaffold schema: z.object({title:z.string()}).strict()
//
// gen-manifests with target:'jsonSchema7' and $refStrategy:'none' produces
// exactly this object (delete $schema; key order preserved by JSON.stringify).
// Verified by running gen-manifests --dir over a real scaffold in templates/.staging/.
// ---------------------------------------------------------------------------

const BAKED_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: {type: 'string'},
  },
  required: ['title'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// File content generators
// ---------------------------------------------------------------------------

/**
 * manifest.json for a content kind (has schema.ts + baked inputSchema).
 */
function manifestContent(id, kind) {
  const manifest = {
    id,
    name: toTitleCase(id),
    version: '1.0.0',
    author: 'your-name',
    apiVersion: '1',
    kind,
    description: `A ${kind} template — edit this description.`,
    tags: [kind],
    license: 'MIT',
    inputSchema: BAKED_INPUT_SCHEMA,
    sampleProps: {title: 'Sample Title'},
    durationFrames: {min: 30, max: 120},
    rendersOwnText: kind === 'hook' || kind === 'stat' || kind === 'outro',
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * manifest.json for the transition kind (hand-authored inputSchema, no schema.ts).
 */
function transitionManifestContent(id) {
  const manifest = {
    id,
    name: toTitleCase(id),
    version: '1.0.0',
    author: 'your-name',
    apiVersion: '1',
    kind: 'transition',
    description: `A transition template — edit this description.`,
    tags: ['transition'],
    license: 'MIT',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {enum: ['left', 'right', 'up', 'down']},
      },
      additionalProperties: false,
    },
    sampleProps: {direction: 'left'},
    durationFrames: {min: 15, max: 45},
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * schema.ts for content kinds — the zod single source of truth.
 * One required prop: title: z.string().
 *
 * THIS SCHEMA IS FIXED. Its gen-manifests output is BAKED_INPUT_SCHEMA above.
 * If you change this schema you must update BAKED_INPUT_SCHEMA to match.
 */
function schemaTsContent(id) {
  return `/**
 * Input data for the \`${id}\` template.
 *
 * zod is the SINGLE SOURCE OF TRUTH: gen-manifests exports this to the
 * manifest's \`inputSchema\` (JSON Schema). .strict() → additionalProperties:false.
 *
 * Add your props here, then run:
 *   npm run gen-manifests   (or: npm run build)
 * to regenerate \`inputSchema\` in manifest.json before running doctor.
 */
import {z} from 'zod';

export const schema = z
  .object({
    title: z.string(),
  })
  .strict();

export type ${toPascalCase(id)}Data = z.infer<typeof schema>;
`;
}

function toPascalCase(id) {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Component.tsx for content kinds — theme tokens + frame-driven entrance +
 * fail-closed pattern. Imports only react + remotion (frozen surface §15.6).
 */
function componentTsxContent(id) {
  const dataType = `${toPascalCase(id)}Data`;
  return `import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {TemplateProps} from '../sdk';
import type {${dataType}} from './schema';

/**
 * ${id} — starter template.
 *
 * Demonstrates the three component contract rules (§4):
 *   1. Theme tokens only — no hardcoded colors or fonts.
 *   2. useCurrentFrame() within timing.durationInFrames — paints the span.
 *   3. Fail-closed — works without wordTimings (and without any render-derived data).
 *
 * Runtime imports: react, remotion only (frozen surface §15.6).
 */

const CLAMP = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;

const Component: React.FC<TemplateProps<${dataType}>> = ({data, theme, timing}) => {
  const frame = useCurrentFrame();

  // Entrance: fade + rise over the first 20 frames, clamped to durationInFrames.
  const enterEnd = Math.min(20, timing.durationInFrames);
  const progress = interpolate(frame, [0, enterEnd], [0, 1], CLAMP);
  const opacity = progress;
  const translateY = interpolate(progress, [0, 1], [40, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.palette.background,
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 96px',
      }}
    >
      <div
        style={{
          fontFamily: \`\${theme.fonts.heading}, system-ui, sans-serif\`,
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: theme.palette.foreground,
          textAlign: 'center',
          opacity,
          transform: \`translateY(\${translateY}px)\`,
        }}
      >
        {data.title}
      </div>

      {/* Accent underline */}
      <div
        style={{
          position: 'absolute',
          bottom: '30%',
          width: 120,
          height: 6,
          borderRadius: 999,
          backgroundColor: theme.palette.accent,
          opacity,
          transform: \`scaleX(\${progress})\`,
          transformOrigin: 'left center',
        }}
      />
    </AbsoluteFill>
  );
};

export default Component;
`;
}

/**
 * presentation.tsx for the transition kind — remotion-primitive factory.
 * Imports only react + remotion + @remotion/transitions (frozen surface §15.6).
 */
function presentationTsxContent(id) {
  return `import React from 'react';
import {AbsoluteFill} from 'remotion';
import type {TransitionPresentationComponentProps} from '@remotion/transitions';
import type {TransitionFactory} from '../sdk';

/**
 * ${id} — starter transition template.
 *
 * A directional clip-path wipe. Built on remotion primitives only.
 * Runtime imports: react, remotion, @remotion/transitions (frozen surface §15.6).
 */

type Direction = 'left' | 'right' | 'up' | 'down';
type P = {direction?: Direction};

function clipPath(direction: Direction, progress: number): string {
  const pct = progress * 100;
  switch (direction) {
    case 'left':  return \`inset(0 \${100 - pct}% 0 0)\`;
    case 'right': return \`inset(0 0 0 \${100 - pct}%)\`;
    case 'up':    return \`inset(0 0 \${100 - pct}% 0)\`;
    case 'down':  return \`inset(\${100 - pct}% 0 0 0)\`;
  }
}

const PresentationComponent: React.FC<TransitionPresentationComponentProps<P>> = ({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}) => {
  const direction: Direction = (passedProps.direction as Direction) ?? 'left';
  if (presentationDirection === 'entering') {
    return (
      <AbsoluteFill style={{clipPath: clipPath(direction, presentationProgress)}}>
        {children}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill>{children}</AbsoluteFill>;
};

const presentation: TransitionFactory = (props) => ({
  component: PresentationComponent,
  props: {direction: (props?.direction as Direction) ?? 'left'},
});

export default presentation;
`;
}

/**
 * README.md content.
 */
function readmeContent(id, kind) {
  const isTransition = kind === TRANSITION_KIND;
  const propsTable = isTransition
    ? `| Prop      | Type                              | Required | Default | Description               |
|-----------|-----------------------------------|----------|---------|---------------------------|
| direction | "left" \\| "right" \\| "up" \\| "down" | no       | "left"  | Wipe direction            |`
    : `| Prop  | Type   | Required | Description                           |
|-------|--------|----------|---------------------------------------|
| title | string | yes      | The text to animate in.               |`;

  return `# ${toTitleCase(id)}

**Kind:** ${kind} | **Author:** your-name | **License:** MIT | **Version:** 1.0.0

${isTransition
    ? `A directional clip-path wipe transition built on \`remotion\` primitives.\n\nEdit \`presentation.tsx\` and the \`inputSchema\` in \`manifest.json\` to customise the transition.`
    : `A minimal ${kind} template demonstrating the authoring standard's three component rules:\n- Theme tokens only (no hardcoded colors/fonts)\n- \`useCurrentFrame()\` within \`timing.durationInFrames\`\n- Fail-closed (works without render-derived timings)\n\nEdit \`Component.tsx\` and \`schema.ts\` to build your design.`}

## Props

${propsTable}

## Next steps

\`\`\`bash
# 1. Edit the template files.
${isTransition ? '' : `#    After changing schema.ts, regenerate inputSchema:\n#    cd templates && npm run gen-manifests\n`}
# 2. Validate (dry-run — same gate as install):
node templates/scripts/install.mjs doctor <path-to-this-folder>

# 3. Pack into a distributable zip:
node templates/scripts/install.mjs pack <path-to-this-folder> --out <out-dir>
\`\`\`

## Authoring reference

See \`docs/TEMPLATE-AUTHORING.md\` for the full normative standard.
`;
}

// ---------------------------------------------------------------------------
// Main scaffold function (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Scaffold a working template starter at `<outDir>/<id>/`.
 *
 * @param {object} opts
 * @param {string} opts.id    Template id
 * @param {string} opts.kind  Template kind
 * @param {string} opts.outDir  Parent directory to write into
 * @returns {string} The created template directory path
 */
export function scaffold({id, kind, outDir}) {
  const destDir = join(outDir, id);
  if (existsSync(destDir)) {
    throw new Error(`Output directory already exists: ${destDir}`);
  }
  mkdirSync(destDir, {recursive: true});

  const isTransition = kind === TRANSITION_KIND;

  if (isTransition) {
    writeFileSync(join(destDir, 'manifest.json'), transitionManifestContent(id), 'utf8');
    writeFileSync(join(destDir, 'presentation.tsx'), presentationTsxContent(id), 'utf8');
  } else {
    writeFileSync(join(destDir, 'manifest.json'), manifestContent(id, kind), 'utf8');
    writeFileSync(join(destDir, 'schema.ts'), schemaTsContent(id), 'utf8');
    writeFileSync(join(destDir, 'Component.tsx'), componentTsxContent(id), 'utf8');
  }

  writeFileSync(join(destDir, 'README.md'), readmeContent(id, kind), 'utf8');

  return destDir;
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {id, kind, dir} = parseArgs(process.argv);
  const outDir = dir ? resolve(dir) : process.cwd();

  let ok = true;

  if (!id) {
    process.stderr.write('Error: --id is required\n');
    ok = false;
  } else if (!isValidId(id)) {
    process.stderr.write(
      `Error: invalid id "${id}" — must match ^[a-z][a-z0-9-]{1,40}$ (lowercase, no leading dot, not reserved)\n`,
    );
    ok = false;
  }

  if (!kind) {
    process.stderr.write('Error: --kind is required\n');
    ok = false;
  } else if (!ALL_KINDS.includes(kind)) {
    process.stderr.write(
      `Error: invalid kind "${kind}" — must be one of: ${ALL_KINDS.join(', ')}\n`,
    );
    ok = false;
  }

  if (!ok) {
    usage();
    process.exit(1);
  }

  try {
    const destDir = scaffold({id, kind, outDir});
    const relDir = destDir;
    process.stdout.write(`[new-template] scaffolded ${id} (${kind}) → ${destDir}\n\n`);
    process.stdout.write(`Next steps:\n`);
    if (kind !== TRANSITION_KIND) {
      process.stdout.write(`  # After editing schema.ts, regenerate inputSchema:\n`);
      process.stdout.write(`  cd templates && npm run gen-manifests\n\n`);
    }
    process.stdout.write(`  # Validate (dry-run — same gate as install):\n`);
    process.stdout.write(`  node templates/scripts/install.mjs doctor ${destDir}\n\n`);
    process.stdout.write(`  # Pack into a distributable zip:\n`);
    process.stdout.write(`  node templates/scripts/install.mjs pack ${destDir} --out <out-dir>\n`);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}
