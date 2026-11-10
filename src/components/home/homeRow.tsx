import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight } from 'lucide-react';
import CardStrip from '../card/cardStrip';

/**
 * One curated homepage row: a titled header (optional leading subject icon) over a horizontally
 * scrolling strip of cards. With `to` (the page that holds the row's full list) the title itself is a
 * link there, and so is the "See all" at the far end of the header.
 */
const HomeRow = ({
  title,
  icon,
  to,
  children,
}: {
  title: string;
  icon?: ReactNode;
  to?: string;
  children: ReactNode;
}) => (
  <section className="home-section">
    <div className="home-section-head">
      <h2 className="home-section-title">
        {to ? (
          <Link to={to} className="home-section-title-link">
            {icon}
            {title}
            <ChevronRight className="home-section-title-chevron" size={18} strokeWidth={2.25} aria-hidden />
          </Link>
        ) : (
          <>
            {icon}
            {title}
          </>
        )}
      </h2>
      {to && (
        <Link to={to} className="home-section-seeall">
          See all
          <ArrowRight size={15} strokeWidth={2} aria-hidden />
        </Link>
      )}
    </div>
    <CardStrip ariaLabel={title}>{children}</CardStrip>
  </section>
);

export default HomeRow;
