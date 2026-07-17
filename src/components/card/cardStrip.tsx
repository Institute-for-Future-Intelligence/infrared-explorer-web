import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * A horizontally scrolling strip of cards with overflow-aware edge arrows. The scrollbar is hidden;
 * desktop gets Previous / Next chevrons at an edge only while there's more to scroll that way; touch
 * pans natively and the CSS gives the last card a peek at the right edge as the affordance.
 *
 * Shared by the Me hub's section rows and the homepage's curated rows.
 */
const CardStrip = ({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  // Re-derive arrow visibility from the live scroll geometry. The 4px slack absorbs subpixel
  // rounding so a strip that fits exactly never flashes an arrow.
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  // Overflow changes when the strip's width does (sidebar toggle, window resize) AND when its
  // content's width does — cards mount progressively as their thumbnails load, which widens the
  // inner track without resizing the scroll container. Observe both boxes.
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, [update]);

  const scrollByPage = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.9, behavior: 'smooth' });

  return (
    <div className="card-strip-wrapper">
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
      <div className="card-strip" ref={ref} onScroll={update} role="list" aria-label={ariaLabel} tabIndex={0}>
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
