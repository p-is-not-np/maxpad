import {
  type Axis,
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  type Pt,
  REST_V,
  type Sample,
  type Size,
  TAP_SLOP,
  type Tap,
  type View,
  atRest,
  clamp,
  clampPan,
  classifySwipe,
  doubleTapView,
  easeOutCubic,
  fitRatio,
  hitsImage,
  imageTransform,
  isDoubleTap,
  isZoomed,
  lockAxis,
  panLimit,
  pinchView,
  pullLook,
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
} from '../lib/zoom-gesture';

/**
 * The lightbox's gesture surface: wires pointer, wheel and Safari gesture
 * events on `box` to a picture `img`, and draws every frame as ONE
 * `transform` from requestAnimationFrame. No React state changes during a
 * gesture and no layout until it comes to rest; the arithmetic lives in
 * `lib/zoom-gesture` where it is tested.
 *
 * Pointer events rather than touch events: one code path for a finger, a pen
 * and a mouse, and iOS Safari has delivered them since 13. `touch-action: none`
 * on the box (CSS) keeps the browser's own pan and zoom out of it.
 *
 * Returns the teardown.
 */
export interface ZoomCallbacks {
  /** Step the gallery. Absent for a lone image — then a swipe snaps back. */
  onSwipe?: ((delta: number) => void) | undefined;
  /** Close the lightbox: a pull down at 1x, or a tap beside the picture. */
  onDismiss?: (() => void) | undefined;
}

export interface ZoomDeps {
  raf: (cb: (t: number) => void) => number;
  caf: (id: number) => void;
  now: () => number;
  /** When the input HAPPENED — not when the handler got to run. */
  eventTime: (e: Event) => number;
}

const defaultDeps = (): ZoomDeps => ({
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  now: () => performance.now(),
  // Same clock as performance.now(). A busy main thread hands the handlers a
  // backlog of moves at once; timed by when they RAN, the last two look
  // simultaneous or far apart, and a flick reads as no velocity (measured on
  // the live app: moves 16 ms apart handled 70–320 ms apart, and no glide).
  eventTime: (e) => e.timeStamp,
});

type Anim =
  | { kind: 'tween'; from: View; to: View; fade0: number; t0: number; dur: number }
  | { kind: 'fling'; vx: number; vy: number; last: number };

interface Gesture {
  /** `swipe`: one finger at 1x. `pan`: anything that moves the picture (one
   *  finger zoomed, or a pinch). `none`: a mouse at 1x, which only clicks. */
  mode: 'swipe' | 'pan' | 'none';
  pointerType: string;
  everMulti: boolean;
  moved: boolean;
  /** It began by catching a glide or a snap-back. That touch only stops the
   *  picture — it is not a tap, so it must not close the lightbox. */
  caught: boolean;
  t0: number;
  start: Pt;
  /** Baseline, re-taken whenever a finger lands or lifts. */
  v0: View;
  raw0: View;
  c0: Pt;
  d0: number;
  axis: Axis | null;
  delta: Pt;
  samples: Sample[];
  focal: Pt;
}

/** Corner radius at rest, in SCREEN px — divided by the scale it is drawn at. */
const RADIUS = 8;

export function attachZoom(
  box: HTMLElement,
  img: HTMLImageElement,
  cb: { readonly current: ZoomCallbacks },
  deps: ZoomDeps = defaultDeps(),
): () => void {
  let natural: Size = { w: 0, h: 0 };
  let rect = { left: 0, top: 0, w: 0, h: 0 };
  let view: View = { ...IDENTITY };
  let fade = 1;
  let raf = 0;
  let anim: Anim | null = null;
  let g: Gesture | null = null;
  let lastTap: Tap | null = null;
  let wheelIdle: ReturnType<typeof setTimeout> | undefined;
  const pts = new Map<number, Pt>();
  const backdrop = box.closest<HTMLElement>('.chat-img-backdrop');

  const size = (): Size => ({ w: rect.w, h: rect.h });
  const measure = () => {
    const r = box.getBoundingClientRect();
    rect = { left: r.left, top: r.top, w: r.width, h: r.height };
  };
  const local = (cx: number, cy: number): Pt => ({
    x: cx - rect.left - rect.w / 2,
    y: cy - rect.top - rect.h / 2,
  });

  /**
   * The scale the picture is LAID OUT at: its size on screen as of the last
   * time it came to rest. While it moves, the transform scales relative to
   * that; at rest the layout catches up and the transform's scale returns to 1.
   *
   * Laying it out at natural size and scaling DOWN (the first version) made
   * the picture a 1179×2556 CSS-px layer for the whole time the lightbox was
   * open — 3537×7668 device px at 3x, ~108 MB — every pixel of it visible and
   * so every tile of it needed. Sized to what is on screen, the browser still
   * draws from the full-resolution file (it is the source bitmap, whatever the
   * box), so a zoomed picture is just as sharp, and the layer is never bigger
   * than the picture as you see it.
   */
  let layoutK = 0;
  const layout = (k: number) => {
    layoutK = k;
    img.style.width = `${natural.w * k}px`;
    img.style.height = `${natural.h * k}px`;
  };

  const paint = () => {
    if (!natural.w) return;
    const { tx, ty, k } = imageTransform(view, natural, size());
    if (!layoutK) layout(k);
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${k / layoutK})`;
    backdrop?.style.setProperty('--chat-img-fade', String(fade));
  };

  /**
   * At rest: re-lay the picture out at the size it is shown, drop the
   * compositing hint, and put back what only matters when still. Both make
   * the browser redraw it sharp at its final size.
   */
  const rest = () => {
    img.classList.remove('-moving');
    img.classList.toggle('-zoomed', isZoomed(view.s));
    const k = fitRatio(natural, size()) * view.s;
    if (k && natural.w && Math.abs(k - layoutK) > 1e-9) {
      layout(k);
      paint();
    }
    img.style.borderRadius = isZoomed(view.s) || !k ? '0' : `${RADIUS}px`;
  };
  const moving = () => img.classList.add('-moving');

  const frame = (t: number) => {
    raf = 0;
    if (anim?.kind === 'tween') {
      const p = Math.min(1, (t - anim.t0) / anim.dur);
      const e = easeOutCubic(p);
      view = tweenView(anim.from, anim.to, e);
      fade = anim.fade0 + (1 - anim.fade0) * e;
      if (p >= 1) anim = null;
    } else if (anim?.kind === 'fling') {
      const dt = Math.min(64, Math.max(0, t - anim.last));
      anim.last = t;
      const L = panLimit(natural, size(), view.s);
      const ax = stepAxis(view.x, anim.vx, dt, -L.x, L.x);
      const ay = stepAxis(view.y, anim.vy, dt, -L.y, L.y);
      view = { s: view.s, x: ax.p, y: ay.p };
      anim.vx = ax.v;
      anim.vy = ay.v;
      if (atRest(ax.p, ax.v, -L.x, L.x) && atRest(ay.p, ay.v, -L.y, L.y)) {
        view = clampPan(view, natural, size());
        anim = null;
      }
    }
    paint();
    if (anim) schedule();
    else if (!g) rest();
  };
  const schedule = () => {
    if (!raf) raf = deps.raf(frame);
  };

  const tweenTo = (to: View, dur = 260) => {
    moving();
    anim = { kind: 'tween', from: { ...view }, to, fade0: fade, t0: deps.now(), dur };
    schedule();
  };
  const stop = () => {
    anim = null;
  };

  // ─── Pointers ─────────────────────────────────────────────────────────────

  const firstTwo = () => [...pts.values()].slice(0, 2);
  const centroid = (): Pt => {
    const [a, b] = firstTwo();
    if (!a) return { x: 0, y: 0 };
    return b ? local((a.x + b.x) / 2, (a.y + b.y) / 2) : local(a.x, a.y);
  };
  const spread = () => {
    const [a, b] = firstTwo();
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  /** Re-take the baseline from what is ON SCREEN, un-banding it so the next
   *  frame re-applies the band to the raw value and nothing jumps. */
  const rebase = (gs: Gesture) => {
    const L = panLimit(natural, size(), view.s);
    gs.v0 = { ...view };
    gs.raw0 = {
      s: unsoftScale(view.s),
      x: unrubber(view.x, -L.x, L.x, rect.w),
      y: unrubber(view.y, -L.y, L.y, rect.h),
    };
    gs.c0 = centroid();
    gs.d0 = spread() || 1;
    gs.samples = [];
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!natural.w) return;
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection
    measure();
    // Catch it mid-flight, the way a finger stops a scrolling list.
    const caught = anim !== null;
    stop();
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      // jsdom, or a pointer the browser already let go of — nothing to keep.
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!g) {
      const swipe = swipeAllowed(view.s, e.pointerType, false);
      g = {
        mode: swipe ? 'swipe' : e.pointerType === 'mouse' && !isZoomed(view.s) ? 'none' : 'pan',
        pointerType: e.pointerType,
        everMulti: false,
        moved: false,
        caught,
        t0: deps.eventTime(e),
        start: { x: e.clientX, y: e.clientY },
        v0: { ...view },
        raw0: { ...view },
        c0: { x: 0, y: 0 },
        d0: 1,
        axis: null,
        delta: { x: 0, y: 0 },
        samples: [],
        focal: local(e.clientX, e.clientY),
      };
    }
    if (pts.size >= 2) {
      // A second finger turns ANY gesture into a zoom, for good: a swipe that
      // grew a finger must not close the picture when they lift.
      g.everMulti = true;
      g.moved = true;
      g.mode = 'pan';
      fade = 1;
    }
    moving();
    rebase(g);
  };

  const onMove = (e: PointerEvent) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const gs = g;
    if (!gs.moved && Math.hypot(e.clientX - gs.start.x, e.clientY - gs.start.y) > TAP_SLOP)
      gs.moved = true;
    const c = centroid();
    gs.samples.push({ t: deps.eventTime(e), x: c.x, y: c.y });
    if (gs.samples.length > 12) gs.samples.shift();
    gs.focal = c;
    if (gs.mode === 'none') return;

    if (gs.mode === 'pan') {
      const s = pts.size >= 2 ? softScale((gs.raw0.s * spread()) / gs.d0) : gs.v0.s;
      // Where the picture would be with no edges: the point under the fingers
      // at the start stays under them now.
      const free = pinchView(gs.v0, gs.c0, c, s);
      const L = panLimit(natural, size(), s);
      view = {
        s,
        x: rubber(gs.raw0.x + (free.x - gs.v0.x), -L.x, L.x, rect.w),
        y: rubber(gs.raw0.y + (free.y - gs.v0.y), -L.y, L.y, rect.h),
      };
    } else {
      const dx = c.x - gs.c0.x;
      const dy = c.y - gs.c0.y;
      gs.delta = { x: dx, y: dy };
      gs.axis ??= lockAxis(dx, dy);
      if (!gs.axis) return;
      const { onSwipe, onDismiss } = cb.current;
      if (gs.axis === 'x') {
        // The picture follows the finger sideways; a lone one resists.
        view = { s: 1, x: onSwipe ? dx : rubber(dx, 0, 0, rect.w), y: 0 };
        fade = 1;
      } else if (dy > 0 && onDismiss) {
        // Pulled down: it shrinks around the finger and follows it anywhere,
        // while the backdrop thins — the Photos "put it away".
        const look = pullLook(dy, rect.h);
        const z = zoomAround(IDENTITY, gs.c0, look.s);
        view = { s: look.s, x: z.x + dx, y: z.y + dy };
        fade = look.fade;
      } else {
        view = { s: 1, x: 0, y: rubber(dy, 0, 0, rect.h) };
        fade = 1;
      }
    }
    schedule();
  };

  const tap = (p: Pt, now: number) => {
    if (!hitsImage(view, natural, size(), p)) {
      // Beside the picture: close, as the empty stage always did.
      lastTap = null;
      cb.current.onDismiss?.();
      return;
    }
    const t = { t: now, x: p.x, y: p.y };
    if (isDoubleTap(lastTap, t)) {
      lastTap = null;
      tweenTo(doubleTapView(view, p, natural, size()), 300);
    } else {
      lastTap = t;
    }
  };

  const end = (gs: Gesture, e: PointerEvent) => {
    const now = deps.eventTime(e);
    const cancelled = e.type === 'pointercancel';
    if (!gs.moved && !gs.everMulti && !gs.caught && !cancelled && now - gs.t0 < 500) {
      tap(local(e.clientX, e.clientY), now);
      if (!anim) rest();
      return;
    }
    lastTap = null;
    const vel = releaseVelocity(gs.samples, now);
    if (gs.mode === 'swipe') {
      const r = cancelled ? null : classifySwipe(gs.axis, gs.delta, vel, gs.v0.s);
      const { onSwipe, onDismiss } = cb.current;
      if (r === 'dismiss' && onDismiss) {
        onDismiss();
        return;
      }
      if ((r === 'next' || r === 'prev') && onSwipe) onSwipe(r === 'next' ? 1 : -1);
      tweenTo({ ...IDENTITY }, 220);
      return;
    }
    if (gs.mode === 'none') {
      rest();
      return;
    }
    const target = settle(view, natural, size(), gs.focal);
    const inRange = view.s >= MIN_ZOOM && view.s <= MAX_ZOOM && isZoomed(view.s);
    if (inRange && !cancelled && Math.hypot(vel.x, vel.y) > REST_V) {
      anim = { kind: 'fling', vx: vel.x, vy: vel.y, last: deps.now() };
      schedule();
    } else if (target.s !== view.s || target.x !== view.x || target.y !== view.y) {
      tweenTo(target);
    } else {
      rest();
    }
  };

  const onUp = (e: PointerEvent) => {
    if (!pts.delete(e.pointerId) || !g) return;
    if (pts.size > 0) {
      // A finger lifted mid-pinch: carry on with the rest, from where it is.
      rebase(g);
      return;
    }
    const gs = g;
    g = null;
    end(gs, e);
  };

  // ─── Wheel and Safari's trackpad pinch ────────────────────────────────────

  const wheelRest = () => {
    clearTimeout(wheelIdle);
    wheelIdle = setTimeout(() => {
      if (!anim && !g) rest();
    }, 160);
  };
  const onWheel = (e: WheelEvent) => {
    if (!natural.w) return;
    // Not passive: ctrl+wheel would otherwise zoom the whole page.
    e.preventDefault();
    measure();
    stop();
    moving();
    if (wheelIntent(e, isZoomed(view.s)) === 'pan') {
      const d = wheelPan(e);
      view = clampPan({ s: view.s, x: view.x + d.x, y: view.y + d.y }, natural, size());
    } else {
      const s = clamp(
        view.s * wheelZoomFactor(wheelPx(e.deltaY, e.deltaMode), e.ctrlKey),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      view = isZoomed(s)
        ? clampPan(zoomAround(view, local(e.clientX, e.clientY), s), natural, size())
        : { ...IDENTITY };
    }
    schedule();
    wheelRest();
  };

  type GestureEv = Event & { scale: number; clientX: number; clientY: number };
  let gesture0: { v: View; c: Pt } | null = null;
  // Desktop Safari sends a trackpad pinch as gesture* events, not ctrl+wheel.
  // iOS sends them TOO, alongside the pointers — so they are ignored whenever
  // a finger is down, or every pinch would be applied twice.
  const onGestureStart = (ev: Event) => {
    ev.preventDefault();
    if (pts.size || !natural.w) return;
    const e = ev as GestureEv;
    measure();
    stop();
    moving();
    gesture0 = { v: { ...view }, c: local(e.clientX, e.clientY) };
  };
  const onGestureChange = (ev: Event) => {
    ev.preventDefault();
    if (pts.size || !gesture0) return;
    const e = ev as GestureEv;
    const s = softScale(gesture0.v.s * e.scale);
    view = zoomAround(gesture0.v, gesture0.c, s);
    schedule();
  };
  const onGestureEnd = (ev: Event) => {
    ev.preventDefault();
    if (!gesture0) return;
    tweenTo(settle(view, natural, size(), gesture0.c));
    gesture0 = null;
  };
  // Outside the box too: on iOS a pinch with a finger on the backdrop would
  // otherwise zoom the PAGE (iOS ignores user-scalable=no).
  const blockPageZoom = (e: Event) => e.preventDefault();

  // ─── Load and resize ──────────────────────────────────────────────────────

  const onLoad = () => {
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    if (!natural.w || !natural.h) return;
    measure();
    view = { ...IDENTITY };
    layoutK = 0;
    paint();
    // Shown once DECODED, not merely loaded: a 3 MP screenshot otherwise
    // paints its first frame blank or half-drawn while iOS decodes it.
    const show = () => {
      img.classList.remove('-pending');
      rest();
    };
    if (typeof img.decode === 'function') img.decode().then(show, show);
    else show();
  };
  const onError = () => img.classList.remove('-pending');
  const ro =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!natural.w) return;
          measure();
          // Synchronously, in the observer: a frame late is a frame of the
          // picture drawn for the old box.
          if (!g && anim?.kind !== 'tween') view = clampPan(view, natural, size());
          paint();
          if (!g && !anim) rest();
        });
  ro?.observe(box);

  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onUp);
  box.addEventListener('wheel', onWheel, { passive: false });
  box.addEventListener('gesturestart', onGestureStart);
  box.addEventListener('gesturechange', onGestureChange);
  box.addEventListener('gestureend', onGestureEnd);
  document.addEventListener('gesturestart', blockPageZoom);
  img.addEventListener('load', onLoad);
  img.addEventListener('error', onError);
  if (img.complete && img.naturalWidth) onLoad();

  return () => {
    if (raf) deps.caf(raf);
    clearTimeout(wheelIdle);
    ro?.disconnect();
    box.removeEventListener('pointerdown', onDown);
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', onUp);
    box.removeEventListener('pointercancel', onUp);
    box.removeEventListener('wheel', onWheel);
    box.removeEventListener('gesturestart', onGestureStart);
    box.removeEventListener('gesturechange', onGestureChange);
    box.removeEventListener('gestureend', onGestureEnd);
    document.removeEventListener('gesturestart', blockPageZoom);
    img.removeEventListener('load', onLoad);
    img.removeEventListener('error', onError);
    backdrop?.style.removeProperty('--chat-img-fade');
  };
}
