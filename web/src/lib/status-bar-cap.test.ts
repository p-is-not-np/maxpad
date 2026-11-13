import { describe, expect, it } from 'vitest';
import { type CapViewport, capTransform, trackStatusBarCap } from './status-bar-cap';

function fakeViewport() {
  const fns = new Set<() => void>();
  const vv = {
    offsetTop: 0,
    addEventListener: (_t: string, fn: () => void) => fns.add(fn),
    removeEventListener: (_t: string, fn: () => void) => fns.delete(fn),
  };
  return {
    vv: vv as CapViewport & { offsetTop: number },
    fire: () => {
      for (const f of fns) f();
    },
    fns,
  };
}

describe('capTransform', () => {
  it('is empty at rest and follows a pan', () => {
    expect(capTransform(0)).toBe('');
    expect(capTransform(-4)).toBe('');
    expect(capTransform(301.6)).toBe('translateY(302px)');
  });
});

describe('trackStatusBarCap', () => {
  it('pins the cap to the visual viewport top as the keyboard pans the page', () => {
    const el = document.createElement('div');
    const { vv, fire, fns } = fakeViewport();
    const stop = trackStatusBarCap(el, vv);
    expect(el.style.transform).toBe('');
    vv.offsetTop = 336;
    fire();
    expect(el.style.transform).toBe('translateY(336px)');
    vv.offsetTop = 0;
    fire();
    expect(el.style.transform).toBe('');
    vv.offsetTop = 120;
    fire();
    stop();
    expect(el.style.transform).toBe('');
    expect(fns.size).toBe(0);
  });

  it('does nothing without a visualViewport', () => {
    const el = document.createElement('div');
    trackStatusBarCap(el, null)();
    expect(el.style.transform).toBe('');
  });
});
