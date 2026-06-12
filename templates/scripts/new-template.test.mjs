// new-template.test.mjs — scaffold-passes-doctor CI test (§9.2 / §15.14).
//
// Verifies that the starter scaffolded by new-template.mjs passes the FULL
// doctor gate (real tsc + real render) for both content and transition kinds.
//
// These tests are REAL doctor runs (~30 s each); generous timeouts are required.
//
// Tmp dirs live under templates/.staging/ so the staged schema.ts can resolve
// `zod` up the node_modules chain — the M3 lesson (§15.6).  However, since
// doctor() always stages the source into templates/.staging/<run-id>/ regardless
// of where the source dir lives, any readable path works.  We use a subdir of
// .staging for belt-and-suspenders.

import {mkdirSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {scaffold} from './new-template.mjs';
import {doctor, STAGING_DIR} from './install.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, '..');

// Use /tmp for the scaffold source dir.  doctor() copies the source into
// templates/.staging/<run-id>/ before staging it, so zod resolves via
// templates/node_modules/zod regardless of where the source lives.
// We intentionally do NOT use templates/.staging/ as the scratch dir because
// _sweepStale() (called at doctor startup) removes ALL subdirectories under
// .staging/ — our scratch dir would be deleted mid-test.
const SCRATCH_DIR = join('/tmp', 'faceless-new-template-test');

beforeAll(() => {
  mkdirSync(SCRATCH_DIR, {recursive: true});
});

afterAll(() => {
  rmSync(SCRATCH_DIR, {recursive: true, force: true});
});

// ---------------------------------------------------------------------------
// Scaffold shape tests (fast — no doctor)
// ---------------------------------------------------------------------------

describe('scaffold() — file shape', () => {
  it('content kind writes manifest + schema.ts + Component.tsx + README.md', () => {
    const dir = join(SCRATCH_DIR, 'shape-scene');
    mkdirSync(dir, {recursive: true});
    const dest = scaffold({id: 'shape-scene', kind: 'scene', outDir: dir});

    expect(existsSync(join(dest, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dest, 'schema.ts'))).toBe(true);
    expect(existsSync(join(dest, 'Component.tsx'))).toBe(true);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(existsSync(join(dest, 'presentation.tsx'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'));
    expect(manifest.id).toBe('shape-scene');
    expect(manifest.kind).toBe('scene');
    expect(manifest.apiVersion).toBe('1');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.license).toBe('MIT');
    expect(manifest.inputSchema).toMatchObject({
      type: 'object',
      properties: {title: {type: 'string'}},
      required: ['title'],
      additionalProperties: false,
    });
    expect(manifest.sampleProps).toMatchObject({title: 'Sample Title'});

    rmSync(dir, {recursive: true, force: true});
  });

  it('transition kind writes manifest + presentation.tsx + README.md (no schema.ts)', () => {
    const dir = join(SCRATCH_DIR, 'shape-transition');
    mkdirSync(dir, {recursive: true});
    const dest = scaffold({id: 'shape-transition', kind: 'transition', outDir: dir});

    expect(existsSync(join(dest, 'manifest.json'))).toBe(true);
    expect(existsSync(join(dest, 'presentation.tsx'))).toBe(true);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    expect(existsSync(join(dest, 'schema.ts'))).toBe(false);
    expect(existsSync(join(dest, 'Component.tsx'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8'));
    expect(manifest.kind).toBe('transition');
    expect(manifest.sampleProps).toMatchObject({direction: 'left'});

    rmSync(dir, {recursive: true, force: true});
  });

  it('throws if the destination directory already exists', () => {
    const dir = join(SCRATCH_DIR, 'shape-exists');
    const dest = join(dir, 'already-there');
    mkdirSync(dest, {recursive: true});
    expect(() => scaffold({id: 'already-there', kind: 'scene', outDir: dir})).toThrow(
      /already exists/,
    );
    rmSync(dir, {recursive: true, force: true});
  });
});

// ---------------------------------------------------------------------------
// scaffold-passes-doctor CI tests (REAL tsc + render, ~30-60 s each)
//
// IMPORTANT: doctor() holds a single-flight lock (§15.2) — these tests MUST
// run sequentially.  vitest runs describes in parallel by default; we run both
// doctor tests inside one describe + it.sequential (or just await them in order).
// ---------------------------------------------------------------------------

describe(
  'scaffold-passes-doctor (scene then transition — sequential, real tsc + render)',
  () => {
    it(
      'scene kind passes doctor',
      async () => {
        const dir = join(SCRATCH_DIR, 'doctor-scene-parent');
        // Clean up any leftover from a prior aborted run
        rmSync(dir, {recursive: true, force: true});
        mkdirSync(dir, {recursive: true});

        const scaffoldDir = scaffold({id: 'scaffold-scene-test', kind: 'scene', outDir: dir});
        expect(existsSync(scaffoldDir)).toBe(true);

        let result;
        try {
          result = await doctor(scaffoldDir);
        } finally {
          // doctor always rolls back its staging copy; clean up the scaffold dir
          rmSync(dir, {recursive: true, force: true});
        }

        expect(result).toMatchObject({ok: true, id: 'scaffold-scene-test', kind: 'scene'});
      },
      900_000,
    );

    it(
      'transition kind passes doctor',
      async () => {
        const dir = join(SCRATCH_DIR, 'doctor-transition-parent');
        rmSync(dir, {recursive: true, force: true});
        mkdirSync(dir, {recursive: true});

        const scaffoldDir = scaffold({id: 'scaffold-transition-test', kind: 'transition', outDir: dir});
        expect(existsSync(scaffoldDir)).toBe(true);

        let result;
        try {
          result = await doctor(scaffoldDir);
        } finally {
          rmSync(dir, {recursive: true, force: true});
        }

        expect(result).toMatchObject({ok: true, id: 'scaffold-transition-test', kind: 'transition'});
      },
      900_000,
    );
  },
  900_000,
);
