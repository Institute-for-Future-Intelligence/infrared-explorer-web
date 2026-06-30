import { RefObject, useEffect } from 'react';

const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10; // a finger that drifts further than this is a drag/scroll, not a press

/**
 * Mobile parity for the analyzer's right-click menus. The whole context-menu system (antd
 * `Dropdown trigger=['contextMenu']`, thermometer selection, the annotation menu) hangs off the
 * native `contextmenu` event — which touch devices don't fire on a long press reliably (iOS Safari
 * never; Android competes with text selection). So we detect the long press ourselves and dispatch
 * a synthetic `contextmenu` at the touch point: every existing onContextMenu handler then fires
 * exactly as it does under a desktop right-click, with no changes to those handlers.
 *
 * The event is dispatched on the deepest element under the finger (`elementFromPoint`) so it bubbles
 * through the right thermometer / annotation and targets the correct one. A press that moves (a
 * thermometer drag, a page scroll) cancels.
 *
 * `ready` re-runs the effect once the target element mounts: a player that returns `null` until its
 * first frame loads only attaches `ref` after the initial commit, so passing a flag that flips true
 * at that point (e.g. `!!currFrameImg`) re-binds the listeners then. Pass a stable boolean — a value
 * that changes every frame would thrash the listeners and drop an in-flight press.
 */
export function useLongPressContextMenu(ref: RefObject<HTMLElement | null>, ready = true): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;

    let timer: number | null = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const clear = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      // Single-finger only: a pinch/two-finger gesture isn't a context-menu press.
      if (e.touches.length !== 1) {
        clear();
        return;
      }
      fired = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        const target = document.elementFromPoint(startX, startY) ?? el;
        target.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: startX, clientY: startY }),
        );
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - startX) > MOVE_CANCEL_PX || Math.abs(t.clientY - startY) > MOVE_CANCEL_PX) clear();
    };

    const onTouchEnd = (e: TouchEvent) => {
      clear();
      // Swallow the click synthesised after the long press so it doesn't immediately dismiss the menu
      // we just opened (or trigger whatever sits under the finger).
      if (fired) {
        e.preventDefault();
        fired = false;
      }
    };

    // Capture phase: a descendant (react-draggable on a thermometer, the native <video>) may
    // stopPropagation on its own touch handling, which would starve a bubble-phase listener — the
    // wrapper must see every press regardless. touchend can't be passive (it preventDefaults the
    // post-press click); the rest are passive so they don't block scroll/drag.
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    el.addEventListener('touchend', onTouchEnd, { capture: true });
    el.addEventListener('touchcancel', clear, { capture: true, passive: true });
    return () => {
      clear();
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      el.removeEventListener('touchcancel', clear, { capture: true });
    };
  }, [ref, ready]);
}
