/**
 * T11: HistoryList stub-vs-finished discrimination tests.
 *
 * Tests cover:
 *   1. discriminateStub — stub detection:
 *      - building: no title, recent (< 5 min)
 *      - failed: no title, old (>= 5 min)
 *      - finished: has title + durationInFrames > 0
 *   2. Edge cases: empty title string, durationInFrames=0, fps absent.
 */

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {discriminateStub} from './projects';
import type {ProjectMeta} from './projects';

// Helper to build a meta. We'll control `Date.now()` via vi.setSystemTime.
function makeMeta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    id: 'auto-test-id',
    topic: 'deep sea creatures',
    createdAt: Date.now(),
    hasRender: false,
    ...overrides,
  };
}

const NOW = new Date('2026-06-13T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── finished projects ────────────────────────────────────────────────────────

describe('discriminateStub — finished', () => {
  it('has title + durationInFrames > 0 → finished', () => {
    const meta = makeMeta({
      title: 'The Deep Ocean',
      durationInFrames: 900,
      fps: 30,
    });
    expect(discriminateStub(meta)).toBe('finished');
  });

  it('large durationInFrames still counts as finished', () => {
    const meta = makeMeta({
      title: 'A Long Video',
      durationInFrames: 9000,
      fps: 30,
    });
    expect(discriminateStub(meta)).toBe('finished');
  });

  it('hasRender does not affect discrimination', () => {
    const meta = makeMeta({
      title: 'Already Rendered',
      durationInFrames: 600,
      fps: 30,
      hasRender: true,
    });
    expect(discriminateStub(meta)).toBe('finished');
  });
});

// ─── building stubs (recent, no title) ───────────────────────────────────────

describe('discriminateStub — building', () => {
  it('no title (absent) + recent → building', () => {
    // Just started (0s ago)
    const meta = makeMeta({createdAt: NOW});
    expect(discriminateStub(meta)).toBe('building');
  });

  it('empty title string + recent → building', () => {
    const meta = makeMeta({title: '', createdAt: NOW - 30_000}); // 30s ago
    expect(discriminateStub(meta)).toBe('building');
  });

  it('whitespace-only title + recent → building', () => {
    const meta = makeMeta({title: '   ', createdAt: NOW - 60_000}); // 1m ago
    expect(discriminateStub(meta)).toBe('building');
  });

  it('durationInFrames=0 + title absent + recent → building', () => {
    const meta = makeMeta({durationInFrames: 0, createdAt: NOW - 120_000}); // 2m ago
    expect(discriminateStub(meta)).toBe('building');
  });

  it('durationInFrames absent + title absent + recent → building', () => {
    const meta = makeMeta({createdAt: NOW - 4 * 60_000}); // 4 min ago (under threshold)
    expect(discriminateStub(meta)).toBe('building');
  });

  it('title present but durationInFrames=0 + recent → building', () => {
    // Title written but spec.json not yet generated
    const meta = makeMeta({
      title: 'Script written but not assembled',
      durationInFrames: 0,
      createdAt: NOW - 60_000,
    });
    expect(discriminateStub(meta)).toBe('building');
  });
});

// ─── failed stubs (old, no title) ────────────────────────────────────────────

describe('discriminateStub — failed', () => {
  it('no title (absent) + old (5min+) → failed', () => {
    const meta = makeMeta({createdAt: NOW - 5 * 60_000}); // exactly 5 min ago
    expect(discriminateStub(meta)).toBe('failed');
  });

  it('empty title + 1h old → failed', () => {
    const meta = makeMeta({title: '', createdAt: NOW - 60 * 60_000});
    expect(discriminateStub(meta)).toBe('failed');
  });

  it('durationInFrames=0 + no title + 10m old → failed', () => {
    const meta = makeMeta({durationInFrames: 0, createdAt: NOW - 10 * 60_000});
    expect(discriminateStub(meta)).toBe('failed');
  });

  it('title present but durationInFrames=0 + old → failed', () => {
    // Started with a title but timed out before generating spec.json
    const meta = makeMeta({
      title: 'Orphaned title',
      durationInFrames: 0,
      createdAt: NOW - 6 * 60_000, // 6min > 5min threshold
    });
    expect(discriminateStub(meta)).toBe('failed');
  });
});

// ─── boundary: exactly at threshold ──────────────────────────────────────────

describe('discriminateStub — threshold boundary (5 min)', () => {
  it('4m59s old + no title → building (just under threshold)', () => {
    const meta = makeMeta({createdAt: NOW - (5 * 60_000 - 1000)});
    expect(discriminateStub(meta)).toBe('building');
  });

  it('5m0s old + no title → failed (at threshold)', () => {
    const meta = makeMeta({createdAt: NOW - 5 * 60_000});
    expect(discriminateStub(meta)).toBe('failed');
  });
});
