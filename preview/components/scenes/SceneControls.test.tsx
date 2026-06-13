// @vitest-environment jsdom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {ScrollPool} from './SceneControls';

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
