/**
 * Keep an opaque cap over the status-bar strip while the keyboard pans the page.
 *
 * ── WHY THE TOP OF THE CHAT WENT SOFT ON AN IPHONE ──────────────────────────
 * The PWA is `viewport-fit=cover` with a `black-translucent` status bar, and
 * `.app-layout` reserves `env(safe-area-inset-top)` so nothing sits under the
 * clock at rest. Focusing the composer changes that: iOS pans the LAYOUT
 * viewport up to bring the field into view (`visualViewport.offsetTop` > 0),
 * the reserved strip and the top bar scroll off the top of the screen, and the
 * conversation slides in under the status bar. iOS 26 then draws its own
 * legibility blur over whatever web content is under the status bar — which is
 * the smear over the text at the top of the screenshot. Nothing in muxpad's
 * CSS blurs anything there; no `backdrop-filter` or mask is involved.
 *
 * The page cannot stop iOS blurring that strip, but it can decide what is IN
 * it: a solid band in the page background, pinned to the VISUAL viewport's
 * top. A blur of one flat colour is that colour, so the edge reads crisp.
 *
 * `position: fixed` is not enough on its own — on iOS a fixed element is fixed
 * to the layout viewport, so it pans away with everything else. Hence the
 * transform, re-applied on every `visualViewport` scroll/resize. At rest
 * (offsetTop 0) the band sits exactly on the strip `.app-layout` already
 * leaves empty in the same colour, so it is invisible.
 */

export interface CapViewport {
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', fn: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', fn: () => void): void;
}

/** The transform that puts the cap on the visual viewport's top edge. */
export function capTransform(offsetTop: number): string {
  const y = Math.max(0, Math.round(offsetTop));
  return y === 0 ? '' : `translateY(${y}px)`;
}

export function trackStatusBarCap(el: HTMLElement, vv: CapViewport | null): () => void {
  if (!vv) return () => {};
  let last: string | null = null;
  const apply = () => {
    const next = capTransform(vv.offsetTop);
    if (next === last) return;
    last = next;
    el.style.transform = next;
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    el.style.transform = '';
  };
}
