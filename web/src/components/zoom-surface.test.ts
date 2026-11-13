import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitRatio, panLimit } from '../lib/zoom-gesture';
import { type ZoomCallbacks, attachZoom } from './zoom-surface';

/**
 * The gesture surface driven end to end: real pointer events into the real
 * handlers, a hand-cranked animation clock, and the geometry jsdom cannot lay
 * out stubbed in (a 360×700 box, an iPhone-screenshot-sized picture). What is
 * asserted is what a person sees: which picture point is under their fingers,
 * read back from the transform the surface wrote.
 */
const BOX = { w: 360, h: 700 };
const NAT = { w: 1179, h: 2556 };
const FIT = fitRatio(NAT, BOX);

let now = 0;
let frames: ((t: number) => void)[] = [];
const deps = {
  raf: (cb: (t: number) => void) => {
    frames.push(cb);
    return frames.length;
  },
  caf: () => {},
  now: () => now,
};
/** Run the animation for `ms` of wall time at 60 fps. */
function flush(ms = 1000) {
  const end = now + ms;
  while (frames.length && now < end) {
    now += 16;
    const run = frames;
    frames = [];
    for (const f of run) f(now);
  }
}

let box: HTMLDivElement;
let img: HTMLImageElement;
let cb: { current: ZoomCallbacks };
let detach: () => void;

beforeEach(() => {
  now = 1000;
  frames = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const backdrop = document.createElement('div');
  backdrop.className = 'chat-img-backdrop';
  box = document.createElement('div');
  img = document.createElement('img');
  box.append(img);
  backdrop.append(box);
  document.body.append(backdrop);
  box.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: BOX.w, height: BOX.h, right: BOX.w, bottom: BOX.h }) as DOMRect;
  Object.defineProperty(img, 'naturalWidth', { value: NAT.w });
  Object.defineProperty(img, 'naturalHeight', { value: NAT.h });
  Object.defineProperty(img, 'complete', { value: true });
  cb = { current: { onSwipe: vi.fn(), onDismiss: vi.fn() } };
  detach = attachZoom(box, img, cb, deps);
});
afterEach(() => {
  detach();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** The drawn transform: translate(tx, ty) scale(k), origin 0 0. */
function drawn() {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(img.style.transform);
  if (!m) throw new Error(`no transform: ${img.style.transform}`);
  return { tx: Number(m[1]), ty: Number(m[2]), k: Number(m[3]) };
}
/** The picture pixel drawn at client point (cx, cy). */
function pixelAt(cx: number, cy: number) {
  const t = drawn();
  return { x: (cx - t.tx) / t.k, y: (cy - t.ty) / t.k };
}
const zoom = () => drawn().k / FIT;

function ptr(type: string, id: number, x: number, y: number, pointerType = 'touch') {
  box.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: id,
      pointerType,
      clientX: x,
      clientY: y,
      button: 0,
    }),
  );
}
/** One finger: down, move in steps, up — `dt` ms apart. */
function drag(
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  { steps = 6, dt = 16, type = 'touch', id = 1 } = {},
) {
  ptr('pointerdown', id, x0, y0, type);
  for (let i = 1; i <= steps; i++) {
    now += dt;
    ptr('pointermove', id, x0 + (dx * i) / steps, y0 + (dy * i) / steps, type);
    flushOne();
  }
  ptr('pointerup', id, x0 + dx, y0 + dy, type);
}
function flushOne() {
  const run = frames;
  frames = [];
  for (const f of run) f(now);
}
function tap(x: number, y: number, type = 'touch') {
  ptr('pointerdown', 9, x, y, type);
  now += 60;
  ptr('pointerup', 9, x, y, type);
}
/** Two fingers from (a0,b0) to (a1,b1), moving together in steps. */
function pinch(
  a0: [number, number],
  b0: [number, number],
  a1: [number, number],
  b1: [number, number],
  { lift = true } = {},
) {
  ptr('pointerdown', 1, ...a0);
  ptr('pointerdown', 2, ...b0);
  for (let i = 1; i <= 8; i++) {
    const f = i / 8;
    now += 16;
    ptr('pointermove', 1, a0[0] + (a1[0] - a0[0]) * f, a0[1] + (a1[1] - a0[1]) * f);
    ptr('pointermove', 2, b0[0] + (b1[0] - b0[0]) * f, b0[1] + (b1[1] - b0[1]) * f);
    flushOne();
  }
  if (lift) {
    now += 200; // held still before lifting: no fling
    ptr('pointerup', 1, ...a1);
    ptr('pointerup', 2, ...b1);
  }
}

describe('load', () => {
  it('lays the picture out at its natural size and fits it with a transform', () => {
    expect(img.style.width).toBe(`${NAT.w}px`);
    expect(img.style.height).toBe(`${NAT.h}px`);
    expect(drawn().k).toBeCloseTo(FIT);
    expect(drawn().ty).toBeCloseTo(0);
  });
});

describe('pinch', () => {
  it('zooms around the point between the fingers, off-centre', () => {
    // Fingers centred on (260, 150) — well off the picture's centre.
    const under = pixelAt(260, 150);
    pinch([230, 150], [290, 150], [170, 150], [350, 150], { lift: false });
    expect(zoom()).toBeCloseTo(3, 1);
    const still = pixelAt(260, 150);
    expect(still.x).toBeCloseTo(under.x, 0);
    expect(still.y).toBeCloseTo(under.y, 0);
  });

  it('pans and zooms at once: the grabbed point follows the moving centroid', () => {
    const under = pixelAt(180, 350);
    pinch([150, 350], [210, 350], [100, 300], [220, 300], { lift: false });
    // Centroid moved to (160, 300); the pixel that was under it went with it.
    const now = pixelAt(160, 300);
    expect(now.x).toBeCloseTo(under.x, 0);
    expect(now.y).toBeCloseTo(under.y, 0);
  });

  it('lifting one finger mid-pinch hands over to a pan with no jump', () => {
    pinch([150, 350], [210, 350], [100, 350], [260, 350], { lift: false });
    const before = drawn();
    ptr('pointerup', 2, 260, 350);
    flushOne();
    expect(drawn()).toEqual(before);
    // …and the remaining finger now pans the picture 1:1.
    const under = pixelAt(100, 350);
    now += 16;
    ptr('pointermove', 1, 70, 330);
    flushOne();
    const after = pixelAt(70, 330);
    expect(after.x).toBeCloseTo(under.x, 1);
    expect(after.y).toBeCloseTo(under.y, 1);
  });

  it('pinched below 1x snaps back to the fitted picture', () => {
    pinch([100, 350], [260, 350], [160, 350], [200, 350], { lift: false });
    expect(zoom()).toBeLessThan(1); // it does shrink under the fingers…
    now += 200;
    ptr('pointerup', 1, 160, 350);
    ptr('pointerup', 2, 200, 350);
    flush();
    expect(zoom()).toBeCloseTo(1); // …and comes back
    expect(drawn().ty).toBeCloseTo(0);
  });

  it('pinched past the max eases back to 5x', () => {
    pinch([175, 350], [185, 350], [0, 350], [360, 350]);
    flush();
    expect(zoom()).toBeCloseTo(5);
  });
});

describe('double-tap', () => {
  it('zooms to 2.5x at the tapped point, and a second double-tap resets', () => {
    const under = pixelAt(120, 250);
    tap(120, 250);
    now += 100;
    tap(120, 250);
    flush();
    expect(zoom()).toBeCloseTo(2.5);
    const at = pixelAt(120, 250);
    expect(at.x).toBeCloseTo(under.x, 0);
    expect(at.y).toBeCloseTo(under.y, 0);
    expect(img.classList.contains('-zoomed')).toBe(true);
    now += 1000;
    tap(120, 250);
    now += 100;
    tap(120, 250);
    flush();
    expect(zoom()).toBeCloseTo(1);
    expect(img.classList.contains('-zoomed')).toBe(false);
  });

  it('a double-click does the same on desktop', () => {
    tap(180, 350, 'mouse');
    now += 100;
    tap(180, 350, 'mouse');
    flush();
    expect(zoom()).toBeCloseTo(2.5);
  });

  it('two taps far apart in time are not a double-tap', () => {
    tap(180, 350);
    now += 600;
    tap(180, 350);
    flush();
    expect(zoom()).toBeCloseTo(1);
  });
});

describe('taps', () => {
  it('a tap beside the picture closes; a tap on it does not', () => {
    tap(180, 350);
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
    now += 1000;
    tap(5, 350); // the picture is ~323px wide: x=5 is backdrop
    expect(cb.current.onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('catching a moving picture', () => {
  it('a tap that stops a snap-back is not a tap beside the picture', () => {
    // A short pull, released: the picture is animating home when the tap lands.
    drag(180, 300, 0, 40, { steps: 4, dt: 30 });
    now += 16;
    flushOne();
    tap(5, 350);
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
  });
});

describe('one-finger pan when zoomed', () => {
  const zoomIn = () => {
    tap(180, 350);
    now += 100;
    tap(180, 350);
    flush();
  };

  it('follows the finger 1:1 inside the bounds', () => {
    zoomIn();
    const under = pixelAt(180, 350);
    ptr('pointerdown', 1, 180, 350);
    now += 16;
    ptr('pointermove', 1, 140, 300);
    flushOne();
    const at = pixelAt(140, 300);
    expect(at.x).toBeCloseTo(under.x, 1);
    expect(at.y).toBeCloseTo(under.y, 1);
  });

  it('a flick keeps gliding after the finger lifts, and stops inside the bounds', () => {
    zoomIn();
    drag(180, 350, -60, 0, { steps: 4, dt: 16 });
    const atLift = drawn().tx;
    now += 16;
    flushOne();
    now += 16;
    flushOne();
    expect(drawn().tx).toBeLessThan(atLift); // still moving left
    flush(3000);
    const L = panLimit(NAT, BOX, 2.5);
    const t = drawn();
    const cx = t.tx + (NAT.w * t.k) / 2 - BOX.w / 2;
    expect(Math.abs(cx)).toBeLessThanOrEqual(L.x + 0.5);
  });

  it('dragged past the edge it resists, then springs back', () => {
    zoomIn();
    const L = panLimit(NAT, BOX, 2.5);
    // Drag right far further than the bound allows, slowly, then hold.
    drag(100, 350, 600, 0, { steps: 20, dt: 16 });
    const t = drawn();
    const centre = t.tx + (NAT.w * t.k) / 2 - BOX.w / 2;
    expect(centre).toBeGreaterThan(L.x); // past the edge…
    expect(centre).toBeLessThan(L.x + 600); // …but less than the finger went
    now += 200;
    flush(3000);
    const t2 = drawn();
    expect(t2.tx + (NAT.w * t2.k) / 2 - BOX.w / 2).toBeCloseTo(L.x, 0);
  });

  it('a long drag DOWN while zoomed pans and never closes', () => {
    zoomIn();
    drag(180, 200, 0, 400);
    flush();
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
    expect(zoom()).toBeCloseTo(2.5);
  });

  it('a long drag SIDEWAYS while zoomed never steps the gallery', () => {
    zoomIn();
    drag(300, 350, -280, 0);
    flush();
    expect(cb.current.onSwipe).not.toHaveBeenCalled();
  });
});

describe('swipes at 1x', () => {
  it('a long pull down closes', () => {
    drag(180, 300, 4, 160, { steps: 8, dt: 30 });
    expect(cb.current.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a short one snaps back, and the backdrop comes back with it', () => {
    drag(180, 300, 0, 40, { steps: 8, dt: 30 });
    now += 200;
    flush();
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
    expect(zoom()).toBeCloseTo(1);
    expect(drawn().ty).toBeCloseTo(0);
    expect(
      document
        .querySelector<HTMLElement>('.chat-img-backdrop')
        ?.style.getPropertyValue('--chat-img-fade'),
    ).toBe('1');
  });

  it('the picture follows the finger while pulled, and the backdrop thins', () => {
    ptr('pointerdown', 1, 180, 300);
    now += 16;
    ptr('pointermove', 1, 180, 420);
    flushOne();
    expect(drawn().ty).toBeGreaterThan(60);
    const fade = Number(
      document
        .querySelector<HTMLElement>('.chat-img-backdrop')
        ?.style.getPropertyValue('--chat-img-fade'),
    );
    expect(fade).toBeLessThan(1);
  });

  it('left is next, right is previous', () => {
    drag(300, 350, -150, 20, { steps: 6, dt: 30 });
    expect(cb.current.onSwipe).toHaveBeenLastCalledWith(1);
    now += 1000;
    drag(60, 350, 150, -20, { steps: 6, dt: 30 });
    expect(cb.current.onSwipe).toHaveBeenLastCalledWith(-1);
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
  });

  it('a swipe that grew a second finger is a pinch to the end and never closes', () => {
    ptr('pointerdown', 1, 180, 200);
    now += 16;
    ptr('pointermove', 1, 180, 260);
    ptr('pointerdown', 2, 180, 400);
    now += 16;
    ptr('pointermove', 2, 180, 500);
    ptr('pointermove', 1, 180, 360);
    ptr('pointerup', 2, 180, 500);
    ptr('pointerup', 1, 180, 360);
    flush();
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
  });

  it('a mouse drag at 1x does nothing — swipes are a touch thing', () => {
    drag(180, 300, 0, 200, { type: 'mouse' });
    drag(300, 350, -200, 0, { type: 'mouse' });
    expect(cb.current.onDismiss).not.toHaveBeenCalled();
    expect(cb.current.onSwipe).not.toHaveBeenCalled();
  });
});

describe('desktop', () => {
  const wheel = (init: WheelEventInit) => {
    const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    box.dispatchEvent(e);
    flushOne();
    return e;
  };

  it('ctrl+wheel (trackpad pinch) zooms at the cursor and keeps the page from zooming', () => {
    // x = 180: until the picture is wider than the box it stays centred on
    // that axis (nothing to pan), so only a centred cursor holds on both.
    const under = pixelAt(180, 120);
    let e: WheelEvent | undefined;
    for (let i = 0; i < 10; i++)
      e = wheel({ ctrlKey: true, deltaY: -10, clientX: 180, clientY: 120 });
    expect(e?.defaultPrevented).toBe(true);
    expect(zoom()).toBeGreaterThan(2);
    const at = pixelAt(180, 120);
    expect(at.x).toBeCloseTo(under.x, 0);
    expect(at.y).toBeCloseTo(under.y, 0);
  });

  const ctrlIn = (n: number) => {
    for (let i = 0; i < n; i++) wheel({ ctrlKey: true, deltaY: -20, clientX: 180, clientY: 350 });
  };

  it('ctrl+wheel zooms back out to exactly fit, never below, and stops at 5x', () => {
    ctrlIn(10);
    expect(zoom()).toBeGreaterThan(1.5);
    for (let i = 0; i < 40; i++) wheel({ ctrlKey: true, deltaY: 20, clientX: 30, clientY: 30 });
    expect(zoom()).toBeCloseTo(1);
    expect(drawn().ty).toBeCloseTo(0);
    ctrlIn(200);
    expect(zoom()).toBeCloseTo(5);
  });

  it('a plain wheel on the fitted picture zooms in at the cursor', () => {
    wheel({ deltaY: -100, clientX: 180, clientY: 350 });
    expect(zoom()).toBeGreaterThan(1.1);
  });

  it('a plain wheel SCROLLS a zoomed picture and leaves the zoom alone', () => {
    ctrlIn(10);
    const z = zoom();
    const before = drawn();
    wheel({ deltaY: 100, clientX: 180, clientY: 350 });
    expect(zoom()).toBeCloseTo(z);
    expect(drawn().ty).toBeCloseTo(before.ty - 100); // content moves up: scrolled down
    wheel({ deltaX: 0, deltaY: 60, shiftKey: true, clientX: 180, clientY: 350 });
    expect(drawn().tx).toBeLessThan(before.tx);
    // …and stops at the edge rather than scrolling into the backdrop.
    for (let i = 0; i < 100; i++) wheel({ deltaY: 100, clientX: 180, clientY: 350 });
    const t = drawn();
    expect(t.ty + NAT.h * t.k).toBeCloseTo(BOX.h, 0);
  });

  it('drag pans a zoomed picture with the mouse', () => {
    ctrlIn(10);
    const under = pixelAt(180, 350);
    ptr('pointerdown', 1, 180, 350, 'mouse');
    now += 16;
    ptr('pointermove', 1, 150, 330, 'mouse');
    flushOne();
    const at = pixelAt(150, 330);
    expect(at.x).toBeCloseTo(under.x, 1);
    expect(at.y).toBeCloseTo(under.y, 1);
  });
});

describe('rendering', () => {
  it('only promotes a layer while moving, so the picture is redrawn sharp at rest', () => {
    tap(180, 350);
    now += 100;
    tap(180, 350);
    expect(img.classList.contains('-moving')).toBe(true);
    flush();
    expect(img.classList.contains('-moving')).toBe(false);
  });

  it('draws nothing but a transform — no width/height change while zooming', () => {
    const w = img.style.width;
    pinch([150, 350], [210, 350], [100, 350], [260, 350]);
    flush();
    expect(img.style.width).toBe(w);
  });
});
