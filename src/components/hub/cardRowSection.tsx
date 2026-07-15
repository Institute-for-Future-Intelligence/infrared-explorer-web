import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';

/*
 * One section row of the Me hub (YouTube-style): a header whose title and "View all" button both
 * lead to the section's full page, over a horizontally scrolling strip of cards. The strip hides
 * its scrollbar; desktop gets overflow-aware chevron arrows at the edges, mobile scrolls by touch
 * (the CSS gives the last card a peek at the right edge as the affordance).
 */

/** The scroll container: watches its own overflow to show/hide the edge arrows. */
const CardStrip = ({ children }: { children: ReactNode }) => {
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
          <LeftOutlined />
        </button>
      )}
      <div className="card-strip" ref={ref} onScroll={update} role="list" tabIndex={0}>
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
          <RightOutlined />
        </button>
      )}
    </div>
  );
};

interface Props {
  title: string;
  /** The section's full page; both the title and "View all" navigate here. */
  to: string;
  children?: ReactNode;
  /** When set, rendered as a full-width block in place of the scroll strip (empty-state note). */
  empty?: ReactNode;
}

const CardRowSection = ({ title, to, children, empty }: Props) => (
  <section className="hub-row">
    <div className="hub-row-header">
      <Link to={to} className="hub-row-title">
        {title}
        <RightOutlined className="hub-row-chevron" />
      </Link>
      <Link to={to} className="hub-row-viewall">
        View all
      </Link>
    </div>
    {empty ? <div className="hub-row-empty">{empty}</div> : <CardStrip>{children}</CardStrip>}
  </section>
);

export default CardRowSection;
