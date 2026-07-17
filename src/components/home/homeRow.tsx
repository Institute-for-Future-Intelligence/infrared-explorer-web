import { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import CardStrip from '../card/cardStrip';

/**
 * One curated homepage row: a titled header (optional leading subject icon) with a "See all" link,
 * over a horizontally scrolling strip of cards. Unlike the Me hub's row, "See all" doesn't navigate
 * — it sets the grid's sort/filter and scrolls down to the full "All experiments" grid below.
 */
const HomeRow = ({
  title,
  icon,
  onSeeAll,
  children,
}: {
  title: string;
  icon?: ReactNode;
  onSeeAll?: () => void;
  children: ReactNode;
}) => (
  <section className="home-section">
    <div className="home-section-head">
      <h2 className="home-section-title">
        {icon}
        {title}
      </h2>
      {onSeeAll && (
        <button type="button" className="home-section-seeall" onClick={onSeeAll}>
          See all
          <ArrowRight size={15} strokeWidth={2} aria-hidden />
        </button>
      )}
    </div>
    <CardStrip ariaLabel={title}>{children}</CardStrip>
  </section>
);

export default HomeRow;
