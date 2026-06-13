// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {ScrollPool, TemplateCardRail} from './SceneControls';

// Mock framer-motion's PUBLIC useReducedMotion so it reads matchMedia live each
// render (framer's real impl caches a module-global listener once, defeating
// per-test stubMatchMedia). Depends only on framer's stable public export.
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  return {
    ...actual,
    useReducedMotion: () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false,
  };
});

(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

// framer-motion's useReducedMotion reads window.matchMedia, which jsdom lacks.
// Default: motion ALLOWED (matches:false). Individual tests can override.
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ScrollPool', () => {
  it('wraps children in a vertical-scroll clamp container', () => {
    act(() => {
      root.render(createElement(ScrollPool, {}, createElement('div', {'data-testid': 'child'}, 'x')));
    });
    const scroller = container.querySelector('[data-scrollpool]') as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('scrollbar-hide');
    // per-breakpoint clamp present (mobile value + sm: override)
    expect(scroller.className).toMatch(/max-h-\[/);
    expect(scroller.className).toMatch(/sm:max-h-\[/);
    expect(container.querySelector('[data-testid="child"]')).toBeTruthy();
  });
});

describe('TemplateCardRail', () => {
  const baseProps = {
    templates: ['scene', 'stat'],
    current: 'stat',
    overridden: false,
    heroClipless: false,
    busy: false,
    onPick: () => {},
  };

  it('renders a radiogroup with one radio card per eligible template', () => {
    act(() => root.render(createElement(TemplateCardRail, baseProps)));
    const group = container.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group).toBeTruthy();
    expect(group.className).toContain('overflow-x-auto'); // horizontal scroll
    const cards = container.querySelectorAll('[role="radio"]');
    expect(cards.length).toBe(2);
  });

  it('marks the current template aria-checked', () => {
    act(() => root.render(createElement(TemplateCardRail, baseProps)));
    const checked = container.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement;
    expect(checked).toBeTruthy();
    expect(checked.textContent).toContain('stat');
  });

  it('disables the scene card on a clipless hero (eligible-but-gated)', () => {
    act(() => root.render(createElement(TemplateCardRail, {
      ...baseProps, current: 'hook', templates: ['hook', 'scene'], heroClipless: true,
    })));
    const sceneCard = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((el) => el.textContent?.includes('scene')) as HTMLButtonElement;
    expect(sceneCard.disabled).toBe(true);
    // tooltip reaches SR/keyboard users, not just hover
    expect(sceneCard.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('calls onPick with the template id when an enabled non-active card is clicked', () => {
    const onPick = vi.fn();
    act(() => root.render(createElement(TemplateCardRail, {...baseProps, onPick})));
    const sceneCard = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((el) => el.textContent?.includes('scene')) as HTMLButtonElement;
    act(() => sceneCard.click());
    expect(onPick).toHaveBeenCalledWith('scene');
  });

  it('plays no video under reduced motion (poster-only)', () => {
    stubMatchMedia(true); // prefers-reduced-motion: reduce
    act(() => root.render(createElement(TemplateCardRail, baseProps)));
    // active card would otherwise autoplay a loop; under reduced motion none render
    expect(container.querySelector('video')).toBeNull();
  });
});
