import { useRef } from 'react';

/**
 * A LONG-PRESS, for the one button on a phone that has a second action.
 *
 * Touch has no modifier keys, so the composer's Queue button carries
 * "interrupt & send now" on a hold. Pointer events, not touch events, so a pen
 * and a mouse hold the same way. The release that ends a hold still fires a
 * `click`; `consume()` reports (once) that this click belongs to a hold the
 * button has already acted on, so the caller can swallow it.
 */
export function useLongPress(onLong: () => void, ms = 500) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  // The hold fires a beat after the render that armed it; call the CURRENT
  // callback, or it would send the draft as it was at pointerdown.
  const latest = useRef(onLong);
  latest.current = onLong;
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  return {
    handlers: {
      onPointerDown: (e: { button: number }) => {
        if (e.button !== 0) return;
        fired.current = false;
        cancel();
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          fired.current = true;
          // A haptic tick where there is one: the hold did something.
          navigator.vibrate?.(10);
          latest.current();
        }, ms);
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
      // iOS/Android raise their own callout on a hold; this hold is ours.
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    },
    consume: (): boolean => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
