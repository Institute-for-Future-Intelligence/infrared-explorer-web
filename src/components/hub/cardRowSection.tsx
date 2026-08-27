import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import CardStrip from '../card/cardStrip';

/*
 * One section row of the Me hub (YouTube-style): a header whose title and "View all" button both
 * lead to the section's full page, over a horizontally scrolling strip of cards (the shared
 * CardStrip). The strip hides its scrollbar; desktop is paged by overflow-aware chevron arrows
 * (whole cards only), mobile scrolls by touch (the CSS gives the last card a peek at the right edge).
 */

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
        <ChevronRight className="hub-row-chevron" size={16} strokeWidth={2} aria-hidden />
      </Link>
      <Link to={to} className="hub-row-viewall">
        View all
      </Link>
    </div>
    {empty ? <div className="hub-row-empty">{empty}</div> : <CardStrip>{children}</CardStrip>}
  </section>
);

export default CardRowSection;
