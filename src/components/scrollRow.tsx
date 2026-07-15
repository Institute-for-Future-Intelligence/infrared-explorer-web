import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';

/**
 * A horizontally-scrolling row with overflow-aware edge arrows (YouTube chip-bar style): the
 * scrollbar is hidden, and a Previous / Next chevron appears at an edge only while there is more to
 * scroll that way. Clicking pages by ~one viewport; touch pans natively.
 */
const ScrollRow = ({ children, ariaLabel }: { children: ReactNode; ariaLabel?: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  // Re-derive arrow visibility from live scroll geometry; 4px slack absorbs subpixel rounding.
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  // Overflow changes when the row's width does (window / sidebar resize) AND when its content's does
  // (chips mount as data loads, or filters change) — the latter widens the track without resizing
  // the scroll container, so observe both boxes.
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => ro.disconnect();
  }, [update]);

  const scrollByPage = (dir: 1 | -1) =>
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <div className="scroll-row-wrapper">
      {canLeft && (
        <>
          <div className="scroll-row-fade left" aria-hidden="true" />
          <button
            type="button"
            className="scroll-row-arrow left"
            aria-label="Previous"
            title="Previous"
            onClick={() => scrollByPage(-1)}
          >
            <LeftOutlined />
          </button>
        </>
      )}
      <div className="scroll-row" ref={ref} onScroll={update} role="group" aria-label={ariaLabel}>
        <div className="scroll-row-track" ref={trackRef}>
          {children}
        </div>
      </div>
      {canRight && (
        <>
          <div className="scroll-row-fade right" aria-hidden="true" />
          <button
            type="button"
            className="scroll-row-arrow right"
            aria-label="Next"
            title="Next"
            onClick={() => scrollByPage(1)}
          >
            <RightOutlined />
          </button>
        </>
      )}
    </div>
  );
};

export default ScrollRow;
