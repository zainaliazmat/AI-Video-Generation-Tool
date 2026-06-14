/**
 * M6 Foundation (F1) — design system token + Button warn variant tests.
 *
 * Strategy: the vitest environment is 'node' (no jsdom). components/ui.tsx
 * uses JSX so we cannot render it here. Instead we:
 *   1. Read the CSS and TS source as text and assert the canonical patterns exist.
 *      This is an intentional contract-level check: if someone renames a token or
 *      removes the variant the test breaks loudly.
 *   2. Skip the ember class toggle test (CSS-only, requires a real browser — rely
 *      on the eyes-on gate instead). A comment marks the skip and explains why.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = join(__dirname, '..');

const globalsCss = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
const tailwindConfig = readFileSync(join(ROOT, 'tailwind.config.ts'), 'utf8');
const uiTsx = readFileSync(join(ROOT, 'components/ui.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// 1) --warn and --warn-soft tokens are declared in :root
// ---------------------------------------------------------------------------
describe('globals.css — warn tokens', () => {
  it('declares --warn: #e8a33d in :root', () => {
    expect(globalsCss).toContain('--warn: #e8a33d');
  });

  it('declares --warn-soft as rgba(232, 163, 61, 0.14)', () => {
    expect(globalsCss).toContain('--warn-soft: rgba(232, 163, 61, 0.14)');
  });

  it('keeps the original --amber token (backward-compat)', () => {
    expect(globalsCss).toContain('--amber: #ff9f0a');
  });
});

// ---------------------------------------------------------------------------
// 2) stale-dot keyframe + class
// ---------------------------------------------------------------------------
describe('globals.css — stale-dot', () => {
  it('defines the stale-glow-pulse keyframe', () => {
    expect(globalsCss).toContain('@keyframes stale-glow-pulse');
  });

  it('declares the .stale-dot class with background: var(--warn)', () => {
    expect(globalsCss).toContain('.stale-dot');
    expect(globalsCss).toContain('background: var(--warn)');
  });

  it('includes an amber box-shadow on .stale-dot', () => {
    // box-shadow carries rgba(232, 163, 61, ...)
    expect(globalsCss).toMatch(/\.stale-dot[\s\S]*?box-shadow:\s*0 0 6px rgba\(232,\s*163,\s*61/);
  });

  it('stale-dot animation is disabled under prefers-reduced-motion', () => {
    // The reduced-motion block for .stale-dot must appear after the class definition
    const rmBlock = globalsCss.indexOf('@media (prefers-reduced-motion: reduce)');
    const staleDotIndex = globalsCss.indexOf('.stale-dot');
    expect(rmBlock).toBeGreaterThan(staleDotIndex);
    // And there's an explicit animation: none override inside it
    expect(globalsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.stale-dot[\s\S]*?animation:\s*none/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3) body.ember theme layer exists in globals.css
// ---------------------------------------------------------------------------
describe('globals.css — body.ember theme', () => {
  it('declares a body.ember block', () => {
    expect(globalsCss).toContain('body.ember');
  });

  it('overrides --accent-1 under body.ember', () => {
    expect(globalsCss).toMatch(/body\.ember\s*\{[\s\S]*?--accent-1:/);
  });

  it('overrides --grad-main under body.ember', () => {
    expect(globalsCss).toMatch(/body\.ember\s*\{[\s\S]*?--grad-main:/);
  });

  it('overrides the ambient gradient on body.ember::before', () => {
    expect(globalsCss).toContain('body.ember::before');
  });

  // SKIPPED: toggling document.body.classList and asserting a computed-style
  // palette change requires a real browser (CSS custom properties in jsdom do
  // not compute through the cascade the same way). Covered by the M6 eyes-on
  // gate — toggle body.ember in DevTools and confirm the rail tints orange.
});

// ---------------------------------------------------------------------------
// 4) tailwind.config.ts — warn repointed + warn-soft added
// ---------------------------------------------------------------------------
describe('tailwind.config.ts — warn tokens', () => {
  it('maps warn to var(--warn)', () => {
    expect(tailwindConfig).toContain("warn: 'var(--warn)'");
  });

  it('maps warn-soft to var(--warn-soft)', () => {
    expect(tailwindConfig).toContain("'warn-soft': 'var(--warn-soft)'");
  });
});

// ---------------------------------------------------------------------------
// 5) Button warn variant exists and carries the amber fill token
// ---------------------------------------------------------------------------
describe('components/ui.tsx — Button warn variant', () => {
  it('includes "warn" in the ButtonVariant union', () => {
    // The type line must enumerate warn
    expect(uiTsx).toMatch(/type ButtonVariant\s*=.*'warn'/);
  });

  it('BUTTON_VARIANTS has a warn key', () => {
    expect(uiTsx).toContain("warn:");
  });

  it('warn variant carries bg-warn (the amber fill token)', () => {
    expect(uiTsx).toContain('bg-warn');
  });

  it('warn variant carries the near-black text color #1a1308 for contrast', () => {
    expect(uiTsx).toContain('text-[#1a1308]');
  });

  it('warn variant carries font-semibold (weight 600 per spec)', () => {
    // The warn variant string should include font-semibold
    expect(uiTsx).toMatch(/warn:.*font-semibold/s);
  });
});
