import { type MouseEvent } from 'react';
import { Popconfirm, Tooltip } from 'antd';
import { Ban, Pin, RotateCcw, Star } from 'lucide-react';

export interface CardCuration {
  /** Effective featured state in the current draft (homepage: in the Showcase; community: staged to
   *  be added to the Showcase). */
  featured: boolean;
  /** 1-based position in the draft hero order, if this card is pinned there. */
  heroRank?: number;
  /** Whether pin-to-hero is offered (only for cards in the showcase pool). */
  canPin: boolean;
  /** Staged for takedown in a draft (community Manage mode) — the card shows a "Will remove · Undo"
   *  state instead of the normal controls. Absent on the homepage, whose takedown is immediate. */
  pendingTakedown?: boolean;
  onToggleFeatured: (next: boolean) => void;
  onTogglePin: () => void;
  /** Take down: stages the removal in the community draft, or (homepage) opens the reason modal. */
  onTakedown: () => void;
  /** Un-stage a drafted takedown (community Manage mode only). */
  onUndoTakedown?: () => void;
}

/**
 * Staff-only curation overlay on a card's media (rendered only in Curate / Manage mode). Feature +
 * takedown edits go to the local draft and are published later in one batch. All controls
 * stopPropagation so they don't open the experiment under them.
 */
const CurationControls = ({
  featured,
  heroRank,
  canPin,
  pendingTakedown,
  onToggleFeatured,
  onTogglePin,
  onTakedown,
  onUndoTakedown,
}: CardCuration) => {
  const stop = (e: MouseEvent) => e.stopPropagation();

  // Staged for removal — a clear "this is leaving" state with an undo, in place of the normal controls.
  if (pendingTakedown) {
    return (
      <div className="card-curate card-curate-staged" onClick={stop}>
        <span className="curate-staged-label">Will remove</span>
        <button type="button" className="curate-btn curate-undo" onClick={onUndoTakedown} aria-label="Undo takedown">
          <RotateCcw size={14} strokeWidth={2} aria-hidden />
          Undo
        </button>
      </div>
    );
  }

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
        description="Applies when you publish your draft."
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
