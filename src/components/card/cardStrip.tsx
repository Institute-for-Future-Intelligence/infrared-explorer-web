import { CSSProperties, ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MOBILE_BREAKPOINT } from '../../hooks/useIsMobile';

/** Phone / tablet widths keep the free touch strip; anything wider is paged. Evaluated with the same
 *  `max-width` query the App.css phone block uses (which hides the arrows and fixes the card width),
 *  so the JS and CSS sides of the breakpoint can't disagree at fractional viewport widths. */
const FREE_STRIP_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * A horizontally scrolling strip of cards with overflow-aware edge arrows. The scrollbar is hidden.
 *
 * Desktop is paged, YouTube-shelf style: the strip works out how many cards fit at their natural
 * width, stretches (or slightly squeezes) them so exactly that many fill the row, masks the gutters
 * so the neighbouring pages' cards can't peek in beside the arrows, and the Previous / Next chevrons
 * (shown at an edge only while there's more that way) move by one full page, with mandatory snap so
 * the strip always rests on a card boundary. A partially visible card at the right edge reads as a
 * clipping bug next to an arrow, so it never happens here.
 *
 * Phones pan natively instead: no arrows, fixed-width cards, and the CSS deliberately leaves the
 * last card peeking at the right edge as the scroll affordance.
 *
 * Shared by the Me hub's section rows and the homepage's curated rows.
 */
const CardStrip = ({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  // Paged layout: the fitted per-card width (px) and the distance one page scrolls. `null` on
  // phones (free strip) or before the first child has mounted (nothing to measure).
  const [page, setPage] = useState<{ itemPx: number; stride: number } | null>(null);
  // Where the arrow scroll currently in flight is headed (null when the scroller is at rest), so a
  // burst of clicks accumulates whole pages instead of re-basing off the animating position.
  const pageTarget = useRef<number | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);

  // Arrow visibility from the live scroll geometry (cheap: runs on every scroll event). The 4px
  // slack absorbs subpixel rounding so a strip that fits exactly never flashes an arrow.
  const updateArrows = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  // Whole-card paging geometry (runs on resize only). Gutter and gap come from the track's computed
  // style (so the CSS stays the single source of truth) and the card's natural width from the
  // `--strip-item-w` custom property each strip item declares (cards vs. class tiles differ).
  //
  // Column count: of the two candidates around the natural fit (floor and floor + 1), take the one
  // whose card width lands closest to natural — so a row never stretches a card past ~1.2× (a
  // single 400px card at a narrow desktop width would read as broken) and never squeezes one much
  // below ~0.85×. The leftover is spread across the columns and rounded down to 1/100 px: rounding
  // to whole pixels would leave up to (cols - 1) px unspent, which shifts the next page's first
  // card that far back into the gutter — past the clip edge on a wide monitor, where it would peek
  // again. A hundredth of a pixel per column can't, and still can't overflow the row into a phantom
  // extra page.
  const updateLayout = useCallback(() => {
    // The geometry is about to change under any scroll in flight, so a destination measured against
    // the old layout is meaningless; the next page re-bases from the scroller's real position.
    pageTarget.current = null;
    const el = ref.current;
    const track = trackRef.current;
    const first = track?.firstElementChild;
    if (!el || !track || !first || window.matchMedia(FREE_STRIP_QUERY).matches) {
      setPage(null);
      return;
    }
    const cs = getComputedStyle(track);
    const gap = parseFloat(cs.columnGap) || 0;
    const inner = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const natural = parseFloat(getComputedStyle(first).getPropertyValue('--strip-item-w'));
    if (!(natural > 0) || inner <= 0) {
      setPage(null);
      return;
    }
    const widthFor = (cols: number) => Math.floor(((inner - (cols - 1) * gap) / cols) * 100) / 100;
    const deviation = (cols: number) => Math.abs(Math.log(widthFor(cols) / natural));
    const floorCols = Math.max(1, Math.floor((inner + gap) / (natural + gap)));
    const cols = deviation(floorCols + 1) < deviation(floorCols) ? floorCols + 1 : floorCols;
    const itemPx = widthFor(cols);
    const stride = cols * (itemPx + gap);
    setPage((prev) => (prev && prev.itemPx === itemPx && prev.stride === stride ? prev : { itemPx, stride }));
  }, []);

  const update = useCallback(() => {
    updateLayout();
    updateArrows();
  }, [updateLayout, updateArrows]);

  // Overflow changes when the strip's width does (sidebar toggle, window resize) AND when its
  // content's width does — cards mount progressively as their thumbnails load, which widens the
  // inner track without resizing the scroll container. Observe both boxes. The first measurement is
  // a layout effect so the paged width is applied before the first paint: a passive effect would
  // paint one frame of natural-width cards and then shift every row below when they widened.
  // (Applying the paged width re-fires the track observer once; the recomputation is idempotent, so
  // it settles.)
  useLayoutEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => {
      ro.disconnect();
      window.clearTimeout(settleTimer.current);
    };
  }, [update]);

  // The arrow pass above measures the DOM before the fitted width it just computed has been applied
  // (that flushes in the re-render this layout effect triggers), so a row that only fits once the
  // cards are squeezed would paint one frame with a Next arrow pointing at nothing. Re-derive the
  // arrows once the width is in the DOM — still synchronously, before the first paint.
  useLayoutEffect(updateArrows, [page, updateArrows]);

  // Paged: move exactly one page of whole cards; the mandatory snap then lands on a card boundary.
  // Free strip (arrows are hidden there anyway): most of a viewport. An explicit `behavior` option
  // overrides the stylesheet's reduced-motion `scroll-behavior: auto`, so honour the setting here.
  //
  // Page from the destination of the scroll already in flight, not from `scrollLeft`: mid-animation
  // that reads back a position between pages, so a second click during the ~350ms smooth scroll
  // would re-base off it and mandatory snap would round the result to a card boundary instead of a
  // page one — a burst of clicks then advances a fraction of what was asked and silently skips a
  // card. `pageTarget` is dropped once scrolling stops (below) or the geometry changes, so a resize
  // or a manual pan re-bases from the real position.
  const scrollByPage = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const step = page ? page.stride : el.clientWidth * 0.9;
    const base = pageTarget.current ?? el.scrollLeft;
    const left = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, base + dir * step));
    pageTarget.current = left;
    el.scrollTo({ left, behavior: window.matchMedia(REDUCED_MOTION_QUERY).matches ? 'auto' : 'smooth' });
  };

  // Every scroll (ours or the user's) refreshes the arrows and restarts the settle timer; when the
  // scroller has been still for a moment, the in-flight destination is stale and gets forgotten.
  const onScroll = () => {
    updateArrows();
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      pageTarget.current = null;
    }, 150);
  };

  const style = page ? ({ '--strip-item-px': `${page.itemPx}px` } as CSSProperties) : undefined;

  return (
    <div className={`card-strip-wrapper${page ? ' is-paged' : ''}`} style={style}>
      {canLeft && (
        <button
          type="button"
          className="strip-arrow strip-arrow-left"
          aria-label="Scroll back"
          onClick={() => scrollByPage(-1)}
        >
          <ChevronLeft size={20} strokeWidth={2} aria-hidden />
        </button>
      )}
      <div className="card-strip" ref={ref} onScroll={onScroll} role="list" aria-label={ariaLabel} tabIndex={0}>
        <div className="card-strip-track" ref={trackRef}>
          {children}
        </div>
      </div>
      {canRight && (
        <button
          type="button"
          className="strip-arrow strip-arrow-right"
          aria-label="Scroll forward"
          onClick={() => scrollByPage(1)}
        >
          <ChevronRight size={20} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
  );
};

export default CardStrip;
