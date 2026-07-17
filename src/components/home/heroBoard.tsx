import { Play } from 'lucide-react';
import SubjectTag from '../card/subjectTag';
import useDownloadUrl from '../card/useDownloadUrl';
import type { ShowcaseCard } from '../../utils/homeLayout';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');

/** One hero tile: a full-bleed thumbnail with the title (+ author, +CTA on the main tile) over a
 *  night-blue scrim. `priority` marks the main tile's image as the LCP element. */
const HeroTile = ({
  item,
  main,
  priority,
  valueProp,
  onOpen,
}: {
  item: ShowcaseCard;
  main?: boolean;
  priority?: boolean;
  valueProp?: string;
  onOpen: (id: string) => void;
}) => {
  const url = useDownloadUrl(item.thumbnailURL);
  const title = stripHtml(item.displayName ?? '');

  return (
    <article
      className={`hero-tile${main ? ' hero-tile-main' : ''}`}
      role="link"
      tabIndex={0}
      aria-label={title}
      onClick={() => onOpen(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item.id);
        }
      }}
    >
      <div className="hero-tile-media">
        {url && (
          <img
            className="hero-tile-img"
            src={url}
            alt=""
            {...(priority ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
          />
        )}
      </div>
      <div className="hero-tile-body">
        <div className="hero-tile-badge">
          <SubjectTag subject={item.subject} />
          {main && <span className="hero-featured">FEATURED</span>}
        </div>
        <h3 className="hero-tile-title">{title}</h3>
        {main && valueProp && <p className="hero-tile-valueprop">{valueProp}</p>}
        {item.author && <p className="hero-tile-author">{item.author}</p>}
        {main && (
          <button
            type="button"
            className="hero-tile-cta"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(item.id);
            }}
          >
            <Play size={15} fill="currentColor" strokeWidth={0} aria-hidden />
            Watch experiment
          </button>
        )}
      </div>
    </article>
  );
};

/**
 * Featured hero board: 1 big tile + up to 4 small ones. Not an auto-rotating banner (K12 banner
 * blindness) — a static editorial board of the top-rated experiments. The main tile is "left image,
 * right text" so its title sits on a solid night panel (legible over any pseudocolour), not on the
 * thumbnail. `valueProp` shows on the main tile for signed-out visitors.
 */
const HeroBoard = ({
  items,
  onOpen,
  valueProp,
}: {
  items: ShowcaseCard[];
  onOpen: (id: string) => void;
  valueProp?: string;
}) => {
  if (items.length === 0) return null;
  const [main, ...rest] = items;
  return (
    <section className="hero-board" aria-label="Featured experiments">
      <HeroTile item={main} main priority valueProp={valueProp} onOpen={onOpen} />
      {rest.slice(0, 4).map((item) => (
        <HeroTile key={item.id} item={item} onOpen={onOpen} />
      ))}
    </section>
  );
};

export default HeroBoard;
