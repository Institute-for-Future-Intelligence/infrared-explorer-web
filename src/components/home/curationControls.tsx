import { type MouseEvent } from 'react';
import { Popconfirm, Tooltip } from 'antd';
import { Ban, Pin, Star } from 'lucide-react';

export interface CardCuration {
  /** Effective featured state in the current draft. */
  featured: boolean;
  /** 1-based position in the draft hero order, if this card is pinned there. */
  heroRank?: number;
  /** Whether pin-to-hero is offered (only for cards in the showcase pool). */
  canPin: boolean;
  onToggleFeatured: (next: boolean) => void;
  onTogglePin: () => void;
  /** Immediate staff takedown (opens the reason modal) — governance, not part of the draft. */
  onTakedown: () => void;
}

/**
 * Staff-only curation overlay on a card's media (rendered only in Curate mode). Feature / pin edits
 * go to the local draft (published later in one batch); takedown is immediate. All controls
 * stopPropagation so they don't open the experiment under them.
 */
const CurationControls = ({ featured, heroRank, canPin, onToggleFeatured, onTogglePin, onTakedown }: CardCuration) => {
  const stop = (e: MouseEvent) => e.stopPropagation();

  const takedownBtn = (
    <Tooltip title="Take down (remove from the site)">
      <button type="button" className="curate-btn curate-takedown" onClick={onTakedown} aria-label="Take down">
        <Ban size={15} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );

  if (!featured) {
    return (
      <div className="card-curate" onClick={stop}>
        {takedownBtn}
        <button
          type="button"
          className="curate-btn curate-add"
          onClick={() => onToggleFeatured(true)}
          title="Add to Showcase"
        >
          <Star size={15} strokeWidth={1.75} aria-hidden />
          Add
        </button>
      </div>
    );
  }

  return (
    <div className="card-curate" onClick={stop}>
      {takedownBtn}
      {canPin && (
        <Tooltip title={heroRank ? `Pinned to hero #${heroRank} — click to unpin` : 'Pin to hero'}>
          <button
            type="button"
            className={`curate-btn curate-pin${heroRank ? ' is-pinned' : ''}`}
            onClick={onTogglePin}
            aria-label={heroRank ? `Unpin from hero (currently #${heroRank})` : 'Pin to hero'}
          >
            {heroRank ? (
              <span className="curate-rank">{heroRank}</span>
            ) : (
              <Pin size={15} strokeWidth={1.75} aria-hidden />
            )}
          </button>
        </Tooltip>
      )}
      <Popconfirm
        title="Remove from Showcase?"
        description="It leaves the homepage when you publish."
        okText="Remove"
        okButtonProps={{ danger: true }}
        cancelText="Cancel"
        onConfirm={() => onToggleFeatured(false)}
      >
        <Tooltip title="In Showcase — click to remove">
          <button type="button" className="curate-btn curate-star is-featured" aria-label="Remove from Showcase">
            <Star size={15} strokeWidth={1.75} fill="currentColor" aria-hidden />
          </button>
        </Tooltip>
      </Popconfirm>
    </div>
  );
};

export default CurationControls;
