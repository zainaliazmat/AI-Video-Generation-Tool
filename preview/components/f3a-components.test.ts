/**
 * F3a: Pure derivation function tests for GateStepper, StatefulStamp, StatusPills.
 *
 * The vitest config uses environment: 'node' — no jsdom.  React component
 * render tests are eyes-on (noted inline).  These tests cover the load-bearing
 * derivation logic that runs in any Node environment.
 */

import {describe, it, expect} from 'vitest';

// ─── StatusPills (ruling 15) ──────────────────────────────────────────────────
import {deriveMediaPill, deriveTemplatePill} from './StatusPills';
import type {SceneState} from '../lib/studio';

// Minimal SceneState fixture factory
function makeScene(overrides: Partial<SceneState> = {}): SceneState {
  return {
    index: 0,
    template: 'scene',
    needsFootage: true,
    beatText: 'test beat',
    durationInFrames: 90,
    candidates: [],
    provenance: null,
    eligibleTemplates: ['scene'],
    templateOverride: null,
    backgroundPool: {rows: [], poolError: null},
    backgroundProvenance: null,
    pickLogCount: 0,
    lastPick: null,
    ...overrides,
  };
}

// ─── deriveMediaPill — footage scenes ────────────────────────────────────────

describe('deriveMediaPill — footage scenes', () => {
  it('pick → "pinned" (indigo/purple)', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 'pick', query: 'dogs', rank: 1, pexelsId: 123, pexelsUrl: 'https://example.com'},
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'pinned', tone: 'purple'});
  });

  it('uploaded → "uploaded" (green)', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 'uploaded', query: null, rank: null, pexelsId: null, pexelsUrl: null},
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'uploaded', tone: 'green'});
  });

  it('re_query → "re-queried" (amber)', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 're_query', query: 'dogs running', rank: 2, pexelsId: 456, pexelsUrl: 'https://example.com'},
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 're-queried', tone: 'amber'});
  });

  it('auto → "auto" (dim)', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 'auto', query: 'dogs', rank: 1, pexelsId: 789, pexelsUrl: 'https://example.com'},
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'auto', tone: 'dim'});
  });

  it('null provenance on footage scene → null (no pill)', () => {
    const scene = makeScene({needsFootage: true, provenance: null});
    const result = deriveMediaPill(scene);
    expect(result).toBeNull();
  });
});

// ─── deriveMediaPill — hero scenes (backgroundProvenance) ────────────────────

describe('deriveMediaPill — hero scenes (backgroundProvenance)', () => {
  it('null backgroundProvenance → "gradient" (dim — floor)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: null,
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'gradient', tone: 'dim'});
  });

  it('source "pinned" → "bg pinned" (indigo/purple)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 'pinned',
        pickedRank: 1,
        query: 'space',
        pexelsId: 100,
        pexelsUrl: 'https://example.com',
        updatedAt: '2026-06-13T00:00:00Z',
      },
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'bg pinned', tone: 'purple'});
  });

  it('source "uploaded" → "uploaded" (green)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 'uploaded',
        pickedRank: null,
        query: null,
        pexelsId: null,
        pexelsUrl: null,
        updatedAt: '2026-06-13T00:00:00Z',
      },
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'uploaded', tone: 'green'});
  });

  it('source "re_query" → "re-queried" (amber)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 're_query',
        pickedRank: 2,
        query: 'galaxy',
        pexelsId: 200,
        pexelsUrl: 'https://example.com',
        updatedAt: '2026-06-13T00:00:00Z',
      },
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 're-queried', tone: 'amber'});
  });

  it('source "bg auto" → "bg auto" (dim)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 'bg auto',
        pickedRank: 1,
        query: 'abstract',
        pexelsId: 300,
        pexelsUrl: 'https://example.com',
        updatedAt: '2026-06-13T00:00:00Z',
      },
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'bg auto', tone: 'dim'});
  });

  it('source "auto" (alias for bg auto) → "bg auto" (dim)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 'auto',
        pickedRank: 1,
        query: 'abstract',
        pexelsId: 301,
        pexelsUrl: 'https://example.com',
        updatedAt: '2026-06-13T00:00:00Z',
      },
    });
    const result = deriveMediaPill(scene);
    expect(result).toEqual({label: 'bg auto', tone: 'dim'});
  });
});

// ─── deriveTemplatePill ───────────────────────────────────────────────────────

describe('deriveTemplatePill', () => {
  it('null templateOverride → null (no pill)', () => {
    const scene = makeScene({templateOverride: null});
    expect(deriveTemplatePill(scene)).toBeNull();
  });

  it('templateOverride present → label is the override value, tone indigo/purple', () => {
    const scene = makeScene({
      templateOverride: {value: 'hero-v2', source: 'manual', pickedRank: null},
    });
    const result = deriveTemplatePill(scene);
    expect(result).toEqual({label: 'hero-v2', tone: 'purple'});
  });

  it('templateOverride with different template id → correct label', () => {
    const scene = makeScene({
      templateOverride: {value: 'stat-card', source: 'ai', pickedRank: 1},
    });
    const result = deriveTemplatePill(scene);
    expect(result).toEqual({label: 'stat-card', tone: 'purple'});
  });
});

// ─── precedence tests ─────────────────────────────────────────────────────────

describe('deriveMediaPill — precedence: uploaded always green regardless of context', () => {
  it('footage uploaded is green (not amber or dim)', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 'uploaded', query: null, rank: null, pexelsId: null, pexelsUrl: null},
    });
    const result = deriveMediaPill(scene);
    expect(result?.tone).toBe('green');
    expect(result?.label).toBe('uploaded');
  });

  it('hero uploaded is green (not dim)', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 'uploaded',
        pickedRank: null,
        query: null,
        pexelsId: null,
        pexelsUrl: null,
        updatedAt: '2026-06-13T00:00:00Z',
      },
    });
    const result = deriveMediaPill(scene);
    expect(result?.tone).toBe('green');
    expect(result?.label).toBe('uploaded');
  });
});

// ─── full pill derivation table (both slots) ─────────────────────────────────

describe('StatusPills full derivation table — both slots together', () => {
  it('footage auto + no template override: auto dim, no template pill', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 'auto', query: 'dogs', rank: 1, pexelsId: 1, pexelsUrl: 'x'},
      templateOverride: null,
    });
    expect(deriveMediaPill(scene)).toEqual({label: 'auto', tone: 'dim'});
    expect(deriveTemplatePill(scene)).toBeNull();
  });

  it('footage pick + template override: pinned purple + template purple', () => {
    const scene = makeScene({
      needsFootage: true,
      provenance: {source: 'pick', query: 'dogs', rank: 1, pexelsId: 1, pexelsUrl: 'x'},
      templateOverride: {value: 'scene-alt', source: 'manual', pickedRank: null},
    });
    expect(deriveMediaPill(scene)).toEqual({label: 'pinned', tone: 'purple'});
    expect(deriveTemplatePill(scene)).toEqual({label: 'scene-alt', tone: 'purple'});
  });

  it('hero gradient + no template override: gradient dim, no template pill', () => {
    const scene = makeScene({needsFootage: false, backgroundProvenance: null, templateOverride: null});
    expect(deriveMediaPill(scene)).toEqual({label: 'gradient', tone: 'dim'});
    expect(deriveTemplatePill(scene)).toBeNull();
  });

  it('hero re_query + template override: re-queried amber + template purple', () => {
    const scene = makeScene({
      needsFootage: false,
      backgroundProvenance: {
        source: 're_query',
        pickedRank: 1,
        query: 'stars',
        pexelsId: 99,
        pexelsUrl: 'x',
        updatedAt: '2026-06-13T00:00:00Z',
      },
      templateOverride: {value: 'hero-dark', source: 'ai', pickedRank: 2},
    });
    expect(deriveMediaPill(scene)).toEqual({label: 're-queried', tone: 'amber'});
    expect(deriveTemplatePill(scene)).toEqual({label: 'hero-dark', tone: 'purple'});
  });
});

// ─── GateStepper: deriveStepVisualState ──────────────────────────────────────
import {deriveStepVisualState} from './GateStepper';
import type {GatesDict} from '../lib/studio';

describe('deriveStepVisualState', () => {
  it('pending — no gate row', () => {
    const gates: GatesDict = {};
    expect(deriveStepVisualState('script', gates, 'script')).toBe('current');
    expect(deriveStepVisualState('voice', gates, 'script')).toBe('pending');
    expect(deriveStepVisualState('scenes', gates, 'script')).toBe('pending');
  });

  it('done — approved gate before current', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(deriveStepVisualState('script', gates, 'voice')).toBe('done');
  });

  it('current — the active gate (awaiting_approval, no approved_at)', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'awaiting_approval', approved_at: null},
    };
    expect(deriveStepVisualState('voice', gates, 'voice')).toBe('current');
  });

  it('reopened — current gate with awaiting_approval + approved_at set', () => {
    const gates: GatesDict = {
      script: {state: 'awaiting_approval', approved_at: '2026-06-13T00:00:00Z'},
    };
    expect(deriveStepVisualState('script', gates, 'script')).toBe('reopened');
  });

  it('stale — gate state is stale', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'stale', approved_at: '2026-06-13T00:01:00Z'},
    };
    expect(deriveStepVisualState('voice', gates, 'script')).toBe('stale');
  });

  it('stale downstream — several downstream gates stale', () => {
    const gates: GatesDict = {
      script: {state: 'awaiting_approval', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'stale', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'stale', approved_at: '2026-06-13T00:02:00Z'},
    };
    expect(deriveStepVisualState('voice', gates, 'script')).toBe('stale');
    expect(deriveStepVisualState('scenes', gates, 'script')).toBe('stale');
  });

  it('full happy path: script done → voice done → scenes current → assemble pending', () => {
    const gates: GatesDict = {
      script: {state: 'approved', approved_at: '2026-06-13T00:00:00Z'},
      voice: {state: 'approved', approved_at: '2026-06-13T00:01:00Z'},
      scenes: {state: 'awaiting_approval', approved_at: null},
    };
    expect(deriveStepVisualState('script', gates, 'scenes')).toBe('done');
    expect(deriveStepVisualState('voice', gates, 'scenes')).toBe('done');
    expect(deriveStepVisualState('scenes', gates, 'scenes')).toBe('current');
    expect(deriveStepVisualState('assemble', gates, 'scenes')).toBe('pending');
  });
});

// ─── StatefulStamp: deriveStampCopy ──────────────────────────────────────────
import {deriveStampCopy} from './StatefulStamp';
import type {Gate} from '../lib/studio';

describe('deriveStampCopy', () => {
  // script gate
  describe('script gate', () => {
    it('pre-approval: contains "script ready" and "grounded"', () => {
      const gate: Gate = {state: 'awaiting_approval', approved_at: null};
      const {text, dotTone} = deriveStampCopy('script', gate, {elapsedS: 6.2, verifiedOk: 6, verifiedTotal: 7});
      expect(text).toContain('script ready');
      expect(text).toContain('grounded');
      expect(text).toContain('verified 6/7');
      expect(text).toContain('6.2');
      expect(dotTone).toBe('green');
    });

    it('approved: exact copy "approved · downstream builds from v1 · editing reopens this gate"', () => {
      const gate: Gate = {state: 'approved', approved_at: '2026-06-13T00:00:00Z'};
      const {text, dotTone} = deriveStampCopy('script', gate);
      expect(text).toBe('approved · downstream builds from v1 · editing reopens this gate');
      expect(dotTone).toBe('green');
    });

    it('reopened: contains "reopened" and amber dot', () => {
      const gate: Gate = {state: 'awaiting_approval', approved_at: '2026-06-13T00:00:00Z'};
      const {text, dotTone} = deriveStampCopy('script', gate);
      expect(text).toContain('reopened');
      expect(dotTone).toBe('amber');
    });
  });

  // voice gate
  describe('voice gate', () => {
    it('approved: "previews ready · script v1 locked"', () => {
      const gate: Gate = {state: 'approved', approved_at: '2026-06-13T00:00:00Z'};
      const {text, dotTone} = deriveStampCopy('voice', gate);
      expect(text).toBe('previews ready · script v1 locked');
      expect(dotTone).toBe('green');
    });

    it('awaiting_approval: contains "locked"', () => {
      const gate: Gate = {state: 'awaiting_approval', approved_at: null};
      const {text} = deriveStampCopy('voice', gate);
      expect(text).toContain('locked');
    });
  });

  // scenes gate
  describe('scenes gate', () => {
    it('approved with counts: shows N scenes · M total · pools fetched X/scene', () => {
      const gate: Gate = {state: 'approved', approved_at: '2026-06-13T00:00:00Z'};
      const {text, dotTone} = deriveStampCopy('scenes', gate, {sceneCount: 7, totalCount: 0, poolsPerScene: 15});
      expect(text).toBe('7 scenes · 0 total · pools fetched 15/scene');
      expect(dotTone).toBe('green');
    });

    it('approved with defaults uses 0/0/15', () => {
      const gate: Gate = {state: 'approved', approved_at: '2026-06-13T00:00:00Z'};
      const {text} = deriveStampCopy('scenes', gate);
      expect(text).toContain('scenes');
      expect(text).toContain('pools fetched 15/scene');
    });
  });

  // assemble gate
  describe('assemble gate', () => {
    it('awaiting_approval: shows spec.json version with checks', () => {
      const gate: Gate = {state: 'awaiting_approval', approved_at: null};
      const {text, dotTone} = deriveStampCopy('assemble', gate, {specVersion: 2});
      expect(text).toBe('spec.json v2 · pydantic ✓ · templates ✓');
      expect(dotTone).toBe('green');
    });

    it('approved: shows spec.json version', () => {
      const gate: Gate = {state: 'approved', approved_at: '2026-06-13T00:00:00Z'};
      const {text} = deriveStampCopy('assemble', gate, {specVersion: 3});
      expect(text).toContain('spec.json v3');
      expect(text).toContain('pydantic ✓');
    });

    it('no gateState → "spec pending"', () => {
      const {text} = deriveStampCopy('assemble', undefined);
      expect(text).toBe('spec pending');
    });
  });
});
