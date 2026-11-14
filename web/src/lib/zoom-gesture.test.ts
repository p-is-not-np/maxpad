import { describe, expect, it } from 'vitest';
import {
  DISMISS_PX,
  IDENTITY,
  MAX_ZOOM,
  SWIPE_PX,
  type View,
  atRest,
  clampPan,
  classifySwipe,
  doubleTapView,
  fitRatio,
  hitsImage,
  imageTransform,
  isDoubleTap,
  lockAxis,
  panLimit,
  pinchView,
  releaseVelocity,
  rubber,
  settle,
  softScale,
  stepAxis,
  swipeAllowed,
  tweenView,
  unrubber,
  unsoftScale,
  wheelIntent,
  wheelPan,
  wheelPx,
  wheelZoomFactor,
  zoomAround,
} from './zoom-gesture';

// A phone-shaped box and an iPhone screenshot: fits by height at 2556 → 700.
const BOX = { w: 360, h: 700 };
const SHOT = { w: 1179, h: 2556 };

/** Where picture point `q` (natural px from its centre) is drawn, box-centre px. */
const screenOf = (v: View, q: { x: number; y: number }) => {
  const k = fitRatio(SHOT, BOX) * v.s;
  return { x: v.x + q.x * k, y: v.y + q.y * k };
};
/** Which picture point is drawn at screen point `p`. */
const pictureAt = (v: View, p: { x: number; y: number }) => {
  const k = fitRatio(SHOT, BOX) * v.s;
  return { x: (p.x - v.x) / k, y: (p.y - v.y) / k };
};

describe('fit', () => {
  it('contains the picture and never upscales a small one', () => {
    expect(fitRatio(SHOT, BOX)).toBeCloseTo(700 / 2556);
    expect(fitRatio({ w: 100, h: 50 }, BOX)).toBe(1);
    expect(fitRatio({ w: 0, h: 0 }, BOX)).toBe(1);
  });

  it('draws the fitted picture centred, from a natural-size layout', () => {
    const t = imageTransform(IDENTITY, SHOT, BOX);
    expect(t.k).toBeCloseTo(700 / 2556);
    expect(t.ty).toBeCloseTo(0);
    expect(t.tx + (SHOT.w * t.k) / 2).toBeCloseTo(BOX.w / 2);
  });

  it('allows no pan at 1x and half the overflow when zoomed', () => {
    expect(panLimit(SHOT, BOX, 1)).toEqual({ x: 0, y: 0 });
    const k = fitRatio(SHOT, BOX) * 3;
    const L = panLimit(SHOT, BOX, 3);
    expect(L.x).toBeCloseTo((SHOT.w * k - BOX.w) / 2);
    expect(L.y).toBeCloseTo((SHOT.h * k - BOX.h) / 2);
  });
});

describe('focal-point zoom', () => {
  it('keeps the picture point under the focal point fixed', () => {
    const v: View = { s: 1.5, x: 20, y: -40 };
    const f = { x: -100, y: 200 };
    const before = pictureAt(v, f);
    const after = pictureAt(zoomAround(v, f, 4), f);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('a pinch keeps the starting point under the fingers as they move AND spread', () => {
    // The old code scaled about the picture's CENTRE and only added the
    // centroid's travel, so a pinch on a corner slid the corner away.
    const start: View = { s: 1, x: 0, y: 0 };
    const c0 = { x: 120, y: -250 }; // near the top-right
    const grabbed = pictureAt(start, c0);
    const c = { x: 60, y: -180 }; // fingers drifted while spreading
    const v = pinchView(start, c0, c, 3);
    const drawn = screenOf(v, grabbed);
    expect(drawn.x).toBeCloseTo(c.x);
    expect(drawn.y).toBeCloseTo(c.y);
  });

  it('does not jump on the first frame of a pinch', () => {
    const start: View = { s: 2, x: 30, y: 10 };
    const c0 = { x: 5, y: 5 };
    expect(pinchView(start, c0, c0, 2)).toEqual(start);
  });

  it('two fingers moving together without spreading is a plain pan', () => {
    const start: View = { s: 2, x: 0, y: 0 };
    const v = pinchView(start, { x: 0, y: 0 }, { x: 40, y: -25 }, 2);
    expect(v).toEqual({ s: 2, x: 40, y: -25 });
  });
});

describe('rubber band', () => {
  it('passes values inside the bounds through untouched', () => {
    expect(rubber(30, -50, 50, 360)).toBe(30);
  });

  it('resists past an edge, more the further it goes, never past `dim`', () => {
    const a = rubber(150, -50, 50, 360) - 50; // 100px over
    const b = rubber(450, -50, 50, 360) - 50; // 400px over
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(100);
    expect(b - a).toBeLessThan(400 - 100);
    expect(rubber(1e9, -50, 50, 360)).toBeLessThan(50 + 360);
    expect(rubber(-150, -50, 50, 360)).toBeCloseTo(-50 - a);
  });

  it('inverts exactly, so re-baselining a pulled gesture does not jump', () => {
    for (const raw of [-400, -51, 0, 49, 75, 300]) {
      const shown = rubber(raw, -50, 50, 360);
      expect(rubber(unrubber(shown, -50, 50, 360), -50, 50, 360)).toBeCloseTo(shown);
      expect(unrubber(shown, -50, 50, 360)).toBeCloseTo(raw);
    }
  });

  it('the scale band shrinks under 1x and barely grows past the max, and inverts', () => {
    expect(softScale(2)).toBe(2);
    expect(softScale(0.25)).toBeCloseTo(0.5);
    expect(softScale(0.25)).toBeLessThan(1);
    expect(softScale(MAX_ZOOM * 2)).toBeGreaterThan(MAX_ZOOM);
    expect(softScale(MAX_ZOOM * 2)).toBeLessThan(MAX_ZOOM * 1.2);
    for (const s of [0.3, 1, 3, 5, 9]) expect(unsoftScale(softScale(s))).toBeCloseTo(s);
  });
});

describe('settling and clamping', () => {
  it('pinched below 1x snaps back to the fitted picture, centred', () => {
    expect(settle({ s: 0.6, x: 40, y: -90 }, SHOT, BOX)).toEqual(IDENTITY);
  });

  it('over the max comes back to the max AROUND the last focal point', () => {
    const v: View = { s: 6, x: 100, y: 50 };
    const f = { x: 80, y: -60 };
    const out = settle(v, SHOT, BOX, f);
    expect(out.s).toBe(MAX_ZOOM);
    const before = pictureAt(v, f);
    const after = pictureAt(out, f);
    // Unless the clamp had to pull an edge in, the focal point did not move.
    const L = panLimit(SHOT, BOX, MAX_ZOOM);
    if (Math.abs(out.x) < L.x && Math.abs(out.y) < L.y) {
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
  });

  it('a pan pulled past an edge comes back to the edge', () => {
    const L = panLimit(SHOT, BOX, 3);
    const out = settle({ s: 3, x: L.x + 80, y: -L.y - 10 }, SHOT, BOX);
    expect(out).toEqual({ s: 3, x: L.x, y: -L.y });
    expect(clampPan({ s: 1, x: 50, y: 50 }, SHOT, BOX)).toEqual({ s: 1, x: 0, y: 0 });
  });
});

describe('double-tap', () => {
  it('zooms to 2.5x keeping the tapped point under the finger', () => {
    const p = { x: 30, y: -120 };
    const v = doubleTapView(IDENTITY, p, SHOT, BOX);
    expect(v.s).toBe(2.5);
    const drawn = screenOf(v, pictureAt(IDENTITY, p));
    expect(drawn.x).toBeCloseTo(p.x);
    expect(drawn.y).toBeCloseTo(p.y);
  });

  it('near an edge it clamps rather than showing empty backdrop', () => {
    const p = { x: 170, y: 340 }; // bottom-right corner of the box
    const v = doubleTapView(IDENTITY, p, SHOT, BOX);
    const L = panLimit(SHOT, BOX, 2.5);
    expect(Math.abs(v.x)).toBeLessThanOrEqual(L.x + 1e-9);
    expect(Math.abs(v.y)).toBeLessThanOrEqual(L.y + 1e-9);
  });

  it('a second double-tap goes back to fit', () => {
    expect(doubleTapView({ s: 2.5, x: 40, y: 40 }, { x: 0, y: 0 }, SHOT, BOX)).toEqual(IDENTITY);
  });

  it('needs two taps close in time and place', () => {
    expect(isDoubleTap(null, { t: 0, x: 0, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 250, x: 10, y: 10 })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 400, x: 0, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 100, x: 200, y: 0 })).toBe(false);
  });

  it('knows whether a tap hit the picture or the backdrop beside it', () => {
    // At 1x the screenshot is ~323px wide in a 360px box: 18px of backdrop each side.
    expect(hitsImage(IDENTITY, SHOT, BOX, { x: 0, y: 0 })).toBe(true);
    expect(hitsImage(IDENTITY, SHOT, BOX, { x: 175, y: 0 })).toBe(false);
  });
});

describe('the double-tap animation', () => {
  it('holds the tapped point still for the whole tween, not just at the end', () => {
    const p = { x: 30, y: -120 };
    const to = doubleTapView(IDENTITY, p, SHOT, BOX);
    const grabbed = pictureAt(IDENTITY, p);
    for (const t of [0.1, 0.4, 0.7]) {
      const drawn = screenOf(tweenView(IDENTITY, to, t), grabbed);
      expect(drawn.x).toBeCloseTo(p.x);
      expect(drawn.y).toBeCloseTo(p.y);
    }
    expect(tweenView(IDENTITY, to, 1)).toEqual(to);
  });

  it('a pure pan tweens linearly', () => {
    expect(tweenView({ s: 2, x: 0, y: 0 }, { s: 2, x: 100, y: -50 }, 0.5)).toEqual({
      s: 2,
      x: 50,
      y: -25,
    });
  });
});

describe('momentum', () => {
  it('glides and decelerates inside the bounds', () => {
    let st = { p: 0, v: 1 }; // 1 px/ms
    for (let i = 0; i < 10; i++) st = stepAxis(st.p, st.v, 16, -1000, 1000);
    expect(st.p).toBeGreaterThan(100);
    expect(st.v).toBeLessThan(1);
    expect(st.v).toBeGreaterThan(0);
  });

  it('travels the same distance whatever the frame rate', () => {
    let a = { p: 0, v: 1.5 };
    let b = { p: 0, v: 1.5 };
    for (let i = 0; i < 60; i++) a = stepAxis(a.p, a.v, 8, -5000, 5000);
    for (let i = 0; i < 30; i++) b = stepAxis(b.p, b.v, 16, -5000, 5000);
    expect(a.p).toBeCloseTo(b.p, 3);
  });

  it('a fling into an edge overshoots softly and comes back to rest ON it', () => {
    let st = { p: 90, v: 2 };
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      st = stepAxis(st.p, st.v, 16, -100, 100);
      peak = Math.max(peak, st.p);
    }
    expect(peak).toBeGreaterThan(100); // it did go past
    expect(peak).toBeLessThan(160); // but not far
    expect(st.p).toBeCloseTo(100);
    expect(atRest(st.p, st.v, -100, 100)).toBe(true);
  });

  it('a released pull past the edge springs back without a velocity', () => {
    let st = { p: -180, v: 0 };
    for (let i = 0; i < 120; i++) st = stepAxis(st.p, st.v, 16, -100, 100);
    expect(st.p).toBeCloseTo(-100);
  });

  it('survives a dropped frame without exploding', () => {
    const st = stepAxis(300, 0, 200, -100, 100);
    expect(st.p).toBeGreaterThanOrEqual(100);
    expect(st.p).toBeLessThan(300);
  });

  it('a finger that stopped before lifting has no velocity', () => {
    const samples = [
      { t: 0, x: 0, y: 0 },
      { t: 16, x: 20, y: 0 },
      { t: 32, x: 40, y: 0 },
    ];
    expect(releaseVelocity(samples, 40).x).toBeCloseTo(40 / 32);
    expect(releaseVelocity(samples, 200)).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([], 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('swipe gating', () => {
  it('a swipe exists only at 1x, for a touch, that never had a second finger', () => {
    expect(swipeAllowed(1, 'touch', false)).toBe(true);
    expect(swipeAllowed(1.0004, 'touch', false)).toBe(true); // float noise is 1x
    expect(swipeAllowed(1.2, 'touch', false)).toBe(false);
    expect(swipeAllowed(2.5, 'pen', false)).toBe(false);
    expect(swipeAllowed(1, 'mouse', false)).toBe(false);
    expect(swipeAllowed(1, 'touch', true)).toBe(false);
  });

  it('never steps or closes while zoomed, however far the drag', () => {
    expect(classifySwipe('x', { x: -500, y: 0 }, { x: -3, y: 0 }, 2)).toBeNull();
    expect(classifySwipe('y', { x: 0, y: 500 }, { x: 0, y: 3 }, 1.5)).toBeNull();
  });

  it('at 1x: left is next, right is prev, down closes, up does nothing', () => {
    const still = { x: 0, y: 0 };
    expect(classifySwipe('x', { x: -SWIPE_PX, y: 0 }, still, 1)).toBe('next');
    expect(classifySwipe('x', { x: SWIPE_PX, y: 0 }, still, 1)).toBe('prev');
    expect(classifySwipe('y', { x: 0, y: DISMISS_PX }, still, 1)).toBe('dismiss');
    expect(classifySwipe('y', { x: 0, y: -300 }, still, 1)).toBeNull();
    expect(classifySwipe('x', { x: -30, y: 0 }, still, 1)).toBeNull();
    expect(classifySwipe('y', { x: 0, y: 40 }, still, 1)).toBeNull();
  });

  it('a quick flick counts with less distance', () => {
    expect(classifySwipe('x', { x: -30, y: 0 }, { x: -1, y: 0 }, 1)).toBe('next');
    expect(classifySwipe('y', { x: 0, y: 45 }, { x: 0, y: 1 }, 1)).toBe('dismiss');
  });

  it('a mostly-down drag with some sideways drift is a pull, and vice versa', () => {
    expect(lockAxis(3, 3)).toBeNull(); // not committed yet
    expect(lockAxis(4, 30)).toBe('y');
    expect(lockAxis(-30, 12)).toBe('x');
    // A sideways swipe never closes, however much it drifted down.
    expect(classifySwipe('x', { x: -150, y: 120 }, { x: 0, y: 0 }, 1)).toBe('next');
    expect(classifySwipe('y', { x: -150, y: 20 }, { x: 0, y: 0 }, 1)).toBeNull();
  });
});

describe('wheel', () => {
  it('ctrl+wheel (a trackpad pinch) always zooms', () => {
    expect(wheelIntent({ ctrlKey: true }, true)).toBe('zoom');
  });
  it('a plain wheel pans a zoomed picture, and zooms the fitted one', () => {
    // Measured before this: a plain wheel-down on a zoomed picture zoomed it
    // back OUT to fit instead of scrolling it.
    expect(wheelIntent({ ctrlKey: false }, true)).toBe('pan');
    expect(wheelIntent({ ctrlKey: false }, false)).toBe('zoom');
  });
  it('the wheel pans against the scroll, and shift turns it sideways', () => {
    expect(wheelPan({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false })).toEqual({
      x: -0,
      y: -100,
    });
    expect(wheelPan({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: true })).toEqual({
      x: -48,
      y: 0,
    });
    expect(wheelPan({ deltaX: 20, deltaY: 0, deltaMode: 0, shiftKey: true })).toEqual({
      x: -20,
      y: -0,
    });
  });
  it('wheel up zooms in, down zooms out, and the two undo each other', () => {
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, false) * wheelZoomFactor(100, false)).toBeCloseTo(1);
  });
  it('normalises line and page deltas', () => {
    expect(wheelPx(3, 1)).toBe(48);
    expect(wheelPx(1, 2)).toBe(400);
    expect(wheelPx(7, 0)).toBe(7);
  });
});
