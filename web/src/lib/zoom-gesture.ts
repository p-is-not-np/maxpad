/**
 * The arithmetic behind the lightbox's zoom, pan and swipe — pure functions, so
 * the parts that decide where a picture lands can be tested without a browser.
 *
 * ─── THE MODEL ──────────────────────────────────────────────────────────────
 * A `View` is three numbers: `s`, the zoom RELATIVE TO THE FITTED SIZE (1 =
 * the whole picture fits the box, 2.5 = double-tap), and `x`/`y`, the offset
 * of the picture's centre from the box's centre in CSS px. Every point here is
 * in the same frame: px from the box centre. The component turns a View into
 * one `transform` on an image laid out at its NATURAL size, so zooming in
 * reveals real pixels rather than upscaling a fitted bitmap.
 *
 * ─── WHY THE RUBBER BAND HAS AN INVERSE ─────────────────────────────────────
 * Past an edge the picture moves less than the finger. When a gesture is
 * re-baselined mid-flight (a second finger lands, one lifts), the new baseline
 * has to be the RAW position that produced what is on screen, or the next
 * frame re-applies the band to an already-banded value and the picture jumps.
 * `unrubber` and `unsoftScale` exist for exactly that hand-off.
 */

export interface Size {
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}
export interface View {
  s: number;
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
export const DOUBLE_TAP_ZOOM = 2.5;
export const IDENTITY: View = { s: 1, x: 0, y: 0 };

/** Below this distance from 1 a view counts as "not zoomed" — float noise. */
const AT_REST = 1e-3;
export const isZoomed = (s: number) => s > MIN_ZOOM + AT_REST;

/**
 * Natural-size → fitted-size ratio: contain inside the box, never upscale a
 * small picture past its real pixels at 1x. 1 for a degenerate input, so a
 * picture with no layout yet renders at natural size rather than vanishing.
 */
export function fitRatio(natural: Size, box: Size): number {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  return Math.min(box.w / natural.w, box.h / natural.h, 1);
}

/** How far the picture's centre may sit from the box's centre at zoom `s`: half
 *  the overflow per axis, 0 on an axis where the picture is smaller than the
 *  box (it stays centred there, the way Photos keeps a zoomed panorama). */
export function panLimit(natural: Size, box: Size, s: number): Pt {
  const k = fitRatio(natural, box) * s;
  return {
    x: Math.max(0, (natural.w * k - box.w) / 2),
    y: Math.max(0, (natural.h * k - box.h) / 2),
  };
}

/** Change the zoom to `s` keeping the picture point under `focal` fixed. */
export function zoomAround(v: View, focal: Pt, s: number): View {
  const r = s / v.s;
  return { s, x: focal.x - (focal.x - v.x) * r, y: focal.y - (focal.y - v.y) * r };
}

/**
 * Two-finger pinch AND pan in one step, computed from the gesture's START, so
 * no error accumulates frame to frame. The picture point that was under the
 * starting centroid `c0` ends up under the current centroid `c`, at zoom `s`.
 * Nothing about this is relative to the picture's centre — the bug it replaces
 * scaled about the centre and only added the centroid's travel, so zooming in
 * on a corner slid that corner off-screen.
 */
export function pinchView(start: View, c0: Pt, c: Pt, s: number): View {
  const r = s / start.s;
  return { s, x: c.x - (c0.x - start.x) * r, y: c.y - (c0.y - start.y) * r };
}

// ─── Rubber band ────────────────────────────────────────────────────────────

/** UIScrollView's constant: how stiff the band feels. */
const RUBBER = 0.55;
const band = (o: number, d: number) => (d <= 0 ? 0 : (d * o * RUBBER) / (o * RUBBER + d));
const unband = (f: number, d: number) => {
  if (d <= 0) return 0;
  // The band approaches `d` asymptotically; a value at or past it has no
  // finite preimage, so cap rather than return Infinity into a transform.
  const g = Math.min(f, d * 0.999);
  return (g * d) / (RUBBER * (d - g));
};

/**
 * iOS's edge resistance: inside [min, max] the value passes through; past an
 * edge it travels less and less, approaching `dim` px of overshoot at most.
 */
export function rubber(v: number, min: number, max: number, dim: number): number {
  if (v < min) return min - band(min - v, dim);
  if (v > max) return max + band(v - max, dim);
  return v;
}
/** The raw value that `rubber` maps to `v` — for re-baselining a live gesture. */
export function unrubber(v: number, min: number, max: number, dim: number): number {
  if (v < min) return min - unband(min - v, dim);
  if (v > max) return max + unband(v - max, dim);
  return v;
}

/**
 * The scale's band. Below 1x the picture still shrinks under the fingers (it
 * has to, or the pinch-out feels dead) but more slowly; above the maximum it
 * barely grows. Both are powers of the ratio, continuous at the edge.
 */
const UNDER = 0.5;
const OVER = 0.25;
export function softScale(raw: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (raw < min) return min * (raw / min) ** UNDER;
  if (raw > max) return max * (raw / max) ** OVER;
  return raw;
}
export function unsoftScale(s: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (s < min) return min * (s / min) ** (1 / UNDER);
  if (s > max) return max * (s / max) ** (1 / OVER);
  return s;
}

// ─── Settling ───────────────────────────────────────────────────────────────

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Hard-clamp a view's pan to the bounds its own zoom allows. */
export function clampPan(v: View, natural: Size, box: Size): View {
  const L = panLimit(natural, box, v.s);
  return { s: v.s, x: clamp(v.x, -L.x, L.x), y: clamp(v.y, -L.y, L.y) };
}

/**
 * Where a released view comes to rest. Pinched under 1x → back to the fitted
 * picture. Over the maximum → back to it, shrinking around `focal` (the last
 * centroid) so the bit you were looking at stays put. Then the pan comes in
 * off any edge it was pulled past.
 */
export function settle(v: View, natural: Size, box: Size, focal: Pt = { x: 0, y: 0 }): View {
  if (!isZoomed(v.s)) return { ...IDENTITY };
  const z = v.s > MAX_ZOOM ? zoomAround(v, focal, MAX_ZOOM) : v;
  return clampPan(z, natural, box);
}

/** Double-tap / double-click: zoomed → fit; fitted → 2.5x at the tapped point. */
export function doubleTapView(v: View, focal: Pt, natural: Size, box: Size): View {
  if (isZoomed(v.s)) return { ...IDENTITY };
  return clampPan(zoomAround(v, focal, DOUBLE_TAP_ZOOM), natural, box);
}

/** Is `p` (box-centre px) on the picture as currently drawn? */
export function hitsImage(v: View, natural: Size, box: Size, p: Pt): boolean {
  const k = fitRatio(natural, box) * v.s;
  return Math.abs(p.x - v.x) <= (natural.w * k) / 2 && Math.abs(p.y - v.y) <= (natural.h * k) / 2;
}

/**
 * The transform for an image laid out at natural size with `transform-origin:
 * 0 0`, drawing view `v` in the middle of `box`. Numbers, not a string, so a
 * test can read them back.
 */
export function imageTransform(v: View, natural: Size, box: Size) {
  const k = fitRatio(natural, box) * v.s;
  return {
    tx: box.w / 2 + v.x - (natural.w * k) / 2,
    ty: box.h / 2 + v.y - (natural.h * k) / 2,
    k,
  };
}

// ─── Momentum ───────────────────────────────────────────────────────────────

/** UIScrollView's normal deceleration rate, per ms. */
export const DECEL = 0.998;
/** Edge spring (per ms²) and its critical damping — no oscillation, one bounce. */
const K = 0.0004;
const C = 2 * Math.sqrt(K);
/** Below this speed (px/ms) and inside the bounds, the glide is over. */
export const REST_V = 0.02;

/**
 * Advance one axis of a fling by `dt` ms. Inside [lo, hi] it glides with
 * exponential friction; outside, a critically damped spring pulls it back to
 * the edge — which is the soft bounce at the end of a fling into a wall.
 */
export function stepAxis(p: number, v: number, dt: number, lo: number, hi: number) {
  let pos = p;
  let vel = v;
  // Sub-stepped so a dropped frame (dt = 50 ms) does not make the spring explode.
  let left = dt;
  while (left > 0) {
    const h = Math.min(left, 4);
    left -= h;
    const edge = pos < lo ? lo : pos > hi ? hi : null;
    if (edge === null) {
      const f = DECEL ** h;
      // Exact integral of v·DECEL^t over the step, so frame rate does not
      // change how far a fling travels.
      pos += (vel * (f - 1)) / Math.log(DECEL);
      vel *= f;
    } else {
      vel += (-K * (pos - edge) - C * vel) * h;
      pos += vel * h;
      // Arrived back at the edge from outside: stop on it rather than
      // creeping across it with the spring's leftover speed.
      if ((edge === lo && pos >= lo) || (edge === hi && pos <= hi)) {
        pos = edge;
        vel = 0;
      }
    }
  }
  return { p: pos, v: vel };
}

export function atRest(p: number, v: number, lo: number, hi: number): boolean {
  return Math.abs(v) < REST_V && p >= lo - 0.5 && p <= hi + 0.5;
}

/**
 * Release velocity from recent samples (px/ms). Only the last 100 ms counts,
 * and a finger that stopped before lifting (no sample in the last 50 ms) has
 * NO velocity — otherwise a careful drag-and-hold flings on release.
 */
export interface Sample {
  t: number;
  x: number;
  y: number;
}
export function releaseVelocity(samples: readonly Sample[], now: number): Pt {
  const last = samples.at(-1);
  if (!last || now - last.t > 50) return { x: 0, y: 0 };
  const recent = samples.filter((s) => last.t - s.t <= 100);
  const first = recent[0];
  if (!first || last.t === first.t) return { x: 0, y: 0 };
  const dt = last.t - first.t;
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

// ─── Swipes ─────────────────────────────────────────────────────────────────

/** Movement before a one-finger drag commits to an axis. */
export const LOCK_PX = 8;
export const SWIPE_PX = 60;
/** Further than a sideways swipe: closing is the bigger consequence. */
export const DISMISS_PX = 90;

export type Axis = 'x' | 'y';
export function lockAxis(dx: number, dy: number): Axis | null {
  if (Math.hypot(dx, dy) < LOCK_PX) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/**
 * May a one-finger drag be a SWIPE (gallery step, pull to close) at all? Only
 * at the fitted size, only for a touch, and only if it started with one finger
 * — a drag that was ever part of a pinch is a zoom gesture to the end. Above
 * 1x one finger pans the picture, and must never throw it away.
 */
export function swipeAllowed(s: number, pointerType: string, everMulti: boolean): boolean {
  return !isZoomed(s) && pointerType !== 'mouse' && !everMulti;
}

export type SwipeResult = 'next' | 'prev' | 'dismiss' | null;
/**
 * What a released swipe does. A fast flick counts with less distance, as on
 * iOS. Left brings the NEXT picture in from the right; down closes; up and
 * anything short of the thresholds snaps back.
 */
export function classifySwipe(axis: Axis | null, d: Pt, v: Pt, s: number): SwipeResult {
  if (isZoomed(s) || !axis) return null;
  if (axis === 'x') {
    if (d.x <= -SWIPE_PX || (v.x < -0.5 && d.x < -20)) return 'next';
    if (d.x >= SWIPE_PX || (v.x > 0.5 && d.x > 20)) return 'prev';
    return null;
  }
  if (d.y >= DISMISS_PX || (v.y > 0.6 && d.y > 30)) return 'dismiss';
  return null;
}

/** How a pull-to-close draws: the picture shrinks and the backdrop fades as it
 *  travels down, so the gesture reads as "putting it away". */
export function pullLook(dy: number, boxH: number): { s: number; fade: number } {
  const t = clamp(dy / Math.max(boxH, 1), 0, 1);
  return { s: 1 - 0.3 * t, fade: 1 - 0.7 * clamp(t * 1.6, 0, 1) };
}

// ─── Taps ───────────────────────────────────────────────────────────────────

export const TAP_SLOP = 10;
export interface Tap {
  t: number;
  x: number;
  y: number;
}
export function isDoubleTap(prev: Tap | null, cur: Tap): boolean {
  return !!prev && cur.t - prev.t <= 300 && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= 40;
}

// ─── Wheel ──────────────────────────────────────────────────────────────────

/** A wheel delta in px whatever its unit (Firefox reports lines). */
export function wheelPx(delta: number, mode: number): number {
  return mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;
}

/**
 * What a wheel event means. ctrl+wheel is a trackpad pinch (the browser
 * synthesizes it) → zoom. A plain wheel zooms too — the mouse case — except
 * when it carries a sideways component while zoomed in, which only a trackpad
 * two-finger scroll produces: that pans, as scrolling a zoomed picture should.
 */
export function wheelIntent(
  e: { ctrlKey: boolean; deltaX: number; deltaY: number },
  zoomed: boolean,
): 'zoom' | 'pan' {
  if (e.ctrlKey) return 'zoom';
  if (zoomed && e.deltaX !== 0) return 'pan';
  return 'zoom';
}

/** Multiplicative zoom for one wheel event; exponential so in and out undo. */
export function wheelZoomFactor(deltaPx: number, ctrlKey: boolean): number {
  const d = clamp(deltaPx, -120, 120);
  return Math.exp(-d * (ctrlKey ? 0.01 : 0.0025));
}

// ─── Animation ──────────────────────────────────────────────────────────────

export const easeOutCubic = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;

/**
 * The view `t` of the way from `from` to `to`. A change of zoom between two
 * views is a similarity with ONE fixed point; interpolating around it keeps
 * the point you double-tapped still for the whole animation, instead of
 * sliding off and back as a straight lerp of (s, x, y) does. The scale moves
 * geometrically, so 1→2.5 and 2.5→1 feel like the same speed.
 */
export function tweenView(from: View, to: View, t: number): View {
  if (t <= 0) return { ...from };
  if (t >= 1) return { ...to };
  const r = to.s / from.s;
  if (Math.abs(r - 1) < 1e-6) {
    return { s: from.s, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  const f = { x: (to.x - r * from.x) / (1 - r), y: (to.y - r * from.y) / (1 - r) };
  return zoomAround(from, f, from.s * r ** t);
}
