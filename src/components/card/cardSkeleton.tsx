/**
 * Placeholder card shown while a thumbnail is still loading. Cards used to render nothing
 * (`return <></>`) until their blob arrived, so the grid reflowed as each card popped in — a CLS
 * mess. This reserves the card's footprint immediately (it takes the same `.card` grid/strip sizing)
 * and fills it with a low-alpha heat shimmer, so the layout is stable from first paint.
 */
const CardSkeleton = () => (
  <div className="card card-skeleton" aria-hidden>
    <div className="card-skeleton-img" />
  </div>
);

export default CardSkeleton;
