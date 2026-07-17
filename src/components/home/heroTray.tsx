import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { ShowcaseCard } from '../../utils/homeLayout';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');

/**
 * Curate-mode editor for the hero order. Lists the staff-pinned experiments (config/homepage.heroIds
 * resolved against the showcase pool) with move-earlier / move-later / remove controls. Any hero
 * slots beyond the pins are algorithm-filled (top-rated); the note says how many. Empty pins = the
 * hero is fully automatic. Reordering here rewrites heroIds; the hero board above updates live.
 */
const HeroTray = ({
  pinned,
  autoCount,
  onMove,
  onRemove,
}: {
  pinned: ShowcaseCard[];
  autoCount: number;
  onMove: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
}) => (
  <section className="hero-tray" aria-label="Hero order">
    <div className="hero-tray-head">
      <span className="hero-tray-title">Hero order</span>
      <span className="hero-tray-note">
        {pinned.length === 0
          ? 'Automatic — top rated. Pin cards below to lock specific slots.'
          : autoCount > 0
            ? `${pinned.length} pinned · ${autoCount} auto-filled by rating`
            : `${pinned.length} pinned`}
      </span>
    </div>
    {pinned.length > 0 && (
      <ol className="hero-tray-items">
        {pinned.map((c, i) => (
          <li className="hero-tray-item" key={c.id}>
            <span className="hero-tray-rank">{i + 1}</span>
            <span className="hero-tray-name" title={stripHtml(c.displayName ?? '')}>
              {stripHtml(c.displayName ?? '')}
            </span>
            <div className="hero-tray-actions">
              <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => onMove(c.id, -1)}>
                <ChevronUp size={16} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Move down"
                disabled={i === pinned.length - 1}
                onClick={() => onMove(c.id, 1)}
              >
                <ChevronDown size={16} strokeWidth={2} aria-hidden />
              </button>
              <button
                type="button"
                className="hero-tray-remove"
                aria-label="Remove from hero"
                onClick={() => onRemove(c.id)}
              >
                <X size={16} strokeWidth={2} aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ol>
    )}
  </section>
);

export default HeroTray;
