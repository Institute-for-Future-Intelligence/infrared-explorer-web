import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Per-history-entry scroll offsets for the app's single scroll container (`.content`). Keyed by React
// Router's location.key, which is unique per history entry — so returning to a page (browser Back, or
// the sidebar's Back button, which calls navigate(-1)) restores exactly where that entry was left,
// while a fresh forward navigation to the same path still starts at the top. In-memory only: a full
// page reload mints new history keys anyway, so persisting the offsets across reloads would only
// strand them under keys that no longer exist.
const offsets = new Map<string, number>();

// The whole app scrolls inside this one persistent div (Layout renders it; App.css gives it
// `overflow-y:auto`), not the window. It stays mounted across route changes, so this is stable.
const getScroller = () => document.querySelector('.content') as HTMLElement | null;

// Restore tuning. The returned-to page usually fetches its data after mount (spinner → grid), so it's
// too short to reach the saved offset at first; we re-apply as it grows.
const SETTLE_FRAMES = 5; // consecutive stable-height frames that mean "the layout has finished"
const RESTORE_CAP_MS = 3000; // hard stop, generous enough for a slow cold-cache Firestore load

/**
 * Scroll-position memory for `.content`.
 *
 * Because the app scrolls inside a div rather than the window, neither the browser's native scroll
 * restoration nor React Router's window-based <ScrollRestoration> apply. This restores it by hand:
 *   • PUSH / REPLACE / first visit → start at the top (opening a new page).
 *   • POP (Back / Forward)         → restore the offset saved for that history entry.
 *
 * The hard part is that list pages (home, /me, My Experiments, profiles…) render a spinner first and
 * only grow to full height once their data arrives, so a single `scrollTop` assignment on return just
 * clamps to ~0. So on a POP we re-apply the target as the content grows. Crucially this is done on
 * requestAnimationFrame, which runs BEFORE the browser paints: the grid's very first painted frame is
 * already scrolled to the saved offset, so the page appears in place with no flash of the top and no
 * visible jump. We stop the instant we reach the offset, the layout settles shorter than before (an
 * item was removed), the user takes over, or a safety cap elapses. Two rules keep the saved offsets
 * honest through all of that:
 *   1. While WE are driving the scroll (`restoring`), the scroll listener does not persist anything —
 *      otherwise the browser's content-shrink clamp and our own re-applies would overwrite the very
 *      offset we're returning to (and a restore interrupted by navigating away would leave it at 0).
 *   2. The frame loop stops as soon as the page stops growing, so it never pins `scrollTop`
 *      frame-after-frame or fights a user who scrolls during the load.
 * Rendered once inside Layout; renders nothing.
 */
const ScrollMemory = () => {
  const { key } = useLocation();
  const navType = useNavigationType(); // 'POP' | 'PUSH' | 'REPLACE'

  useLayoutEffect(() => {
    const el = getScroller();
    if (!el) return;

    // True only while this effect is actively driving the scroll toward a restored target. Saves are
    // suppressed during that window so programmatic writes / clamp events can't corrupt the offset.
    let restoring = false;

    const onScroll = () => {
      if (restoring) return;
      offsets.set(key, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });

    // Only a Back/Forward restores a remembered position; a forward navigation (PUSH) or a same-page
    // URL swap (REPLACE) opens at the top.
    const target = navType === 'POP' ? (offsets.get(key) ?? 0) : 0;

    // Apply immediately: covers a page that's already tall (a static page, warm synchronous data) with
    // no flash of the top before paint, since this runs in a layout effect.
    el.scrollTop = target;

    // Landing at the top needs no chase.
    if (target <= 0) {
      return () => el.removeEventListener('scroll', onScroll);
    }

    restoring = true;
    let raf = 0;
    let stableFrames = 0;
    let lastHeight = -1;
    const capAt = performance.now() + RESTORE_CAP_MS;

    const finish = () => {
      restoring = false;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const frame = () => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.min(target, maxScroll);

      // Reached the saved offset — done.
      if (maxScroll >= target) return finish();

      // Has the page stopped growing? (A still-loading spinner keeps maxScroll ≈ 0; a rendered-but-
      // shorter page holds a stable scrollHeight > the viewport.)
      stableFrames = el.scrollHeight === lastHeight ? stableFrames + 1 : 0;
      lastHeight = el.scrollHeight;

      // Once the content is scrollable AND has held its height steady, it's genuinely shorter than it
      // was when we saved — stop at its bottom rather than pinning it every frame (which would fight
      // the user). While it's still just a spinner (maxScroll ≈ 0) we keep waiting for the data.
      if (maxScroll > 0 && stableFrames >= SETTLE_FRAMES) return finish();
      if (performance.now() > capAt) return finish();

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Genuine scroll intent ends the restore at once so we never yank the user back. `wheel` (mouse /
    // trackpad) and `touchmove` (a touch drag — NOT `touchstart`, which also fires on a plain tap) are
    // the unambiguous signals; our own programmatic `scrollTop` writes trigger neither.
    const onUserTakeover = () => finish();
    el.addEventListener('wheel', onUserTakeover, { passive: true });
    el.addEventListener('touchmove', onUserTakeover, { passive: true });

    return () => {
      finish();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onUserTakeover);
      el.removeEventListener('touchmove', onUserTakeover);
    };
  }, [key, navType]);

  return null;
};

export default ScrollMemory;
