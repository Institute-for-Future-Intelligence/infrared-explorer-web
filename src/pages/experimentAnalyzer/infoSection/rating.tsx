import { ConfigProvider, Rate, Tooltip } from 'antd';
import { StarFilled } from '@ant-design/icons';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { firebaseDatabase } from '../../../services/firebase';
import { Experiment, TRating } from '../../../types';
import useCommonStore from '../../../stores/common';
import { signIn } from '../../../services/auth';

// Teal so the viewer's own stars read as "mine", distinct from the gold community score. Matches
// --ifi-teal (rgba(0,140,140,1)); a concrete value keeps antd's token pipeline from parsing a var().
const MY_STAR_COLOR = '#008c8c';
const COMMUNITY_STAR_COLOR = '#fadb14'; // antd's rating gold

/**
 * Rating state for one experiment, split into the two things the UI needs separately:
 *  - the COMMUNITY score (average + count), read from the experiment's Function-maintained
 *    ratingSum/ratingCount aggregates — the same source the Related cards use, so the two never
 *    disagree, and one fewer full subcollection scan per page view — nudged optimistically when the
 *    viewer rates and reconciled by the aggregateRatings Function a moment later;
 *  - the viewer's OWN rating, read once by doc id (docId == mongoId), so the interactive stars show
 *    what THEY picked instead of snapping back to the community average (the old widget's core lie).
 *
 * Rating is ONE-TIME and immutable: once cast it can't be changed or withdrawn (mirrored in
 * firestore.rules as create-only), so a rated viewer sees their stars locked read-only. Owners can't
 * rate their own experiment, so `isOwner` suppresses both the input and the own-rating read.
 */
export const useRatings = (experiment: Experiment) => {
  const expId = experiment.id;
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && experiment.ownerId === user.id;

  // Community aggregates, seeded from the doc and kept live via optimistic deltas; re-seed on nav
  // (Related hops swap the experiment prop without unmounting this hook).
  const [sum, setSum] = useState(experiment.ratingSum ?? 0);
  const [count, setCount] = useState(experiment.ratingCount ?? 0);
  useEffect(() => {
    setSum(experiment.ratingSum ?? 0);
    setCount(experiment.ratingCount ?? 0);
  }, [experiment.id, experiment.ratingSum, experiment.ratingCount]);

  // The viewer's own rating: 0 = not rated yet, >0 = already rated (locked), null = still loading.
  // Owners never rate.
  const [myRating, setMyRating] = useState<number | null>(null);
  useEffect(() => {
    if (!user || isOwner) {
      setMyRating(0);
      return;
    }
    let cancelled = false;
    getDoc(doc(firebaseDatabase, `experiments/${expId}/ratings/${user.id}`))
      .then((snap) => {
        if (!cancelled) setMyRating(snap.exists() ? (snap.data() as TRating).rating : 0);
      })
      .catch((e) => {
        console.error('failed to load your rating', e);
        if (!cancelled) setMyRating(0);
      });
    return () => {
      cancelled = true;
    };
  }, [expId, user, isOwner]);

  const average = count ? sum / count : 0;

  // Cast the viewer's one-time rating (1-5). Refuses if already rated (immutable) or if the viewer is
  // the owner. Optimistically folds +value/+1 into the community aggregates so the score moves
  // immediately; the aggregateRatings Function recomputes the authoritative sum/count on the write.
  // Rolls the optimism back on failure (e.g. the create-only rule rejecting a stale re-rate).
  const rate = async (value: number) => {
    if (!user) {
      signIn().catch((e) => console.error('sign-in failed', e));
      return;
    }
    if (isOwner) return; // owners don't rate their own experiment (also enforced by rules)
    const prev = myRating ?? 0;
    if (prev > 0) return; // already rated — one-time and immutable
    if (value < 1) return; // ignore a stray 0

    setMyRating(value);
    setSum((s) => s + value);
    setCount((c) => c + 1);

    try {
      await setDoc(doc(firebaseDatabase, `experiments/${expId}/ratings/${user.id}`), { rating: value });
    } catch (e) {
      console.error('failed to save rating', e);
      setMyRating(0);
      setSum((s) => s - value);
      setCount((c) => c - 1);
    }
  };

  return { average, ratingCount: count, myRating, rate, isOwner, signedIn: !!user };
};

/** Read-only community score: a gold star, the precise average, and the rating count. */
export const CommunityScore = ({ average, ratingCount }: { average: number; ratingCount: number }) => {
  if (ratingCount <= 0) return <span className="rating-meta">No ratings yet</span>;
  return (
    <span className="rating-score">
      <StarFilled style={{ color: COMMUNITY_STAR_COLOR }} />
      <b>{average.toFixed(1)}</b>
      <span className="rating-meta">
        · {ratingCount} rating{ratingCount === 1 ? '' : 's'}
      </span>
    </span>
  );
};

interface YourRatingProps {
  myRating: number | null;
  rate: (value: number) => void;
  signedIn: boolean;
}

/**
 * The viewer's own rating (teal, so it reads as "mine" vs the gold community score). Rating is
 * one-time: an unrated viewer gets interactive stars (a signed-out click prompts sign-in instead of a
 * dead no-op); once rated, the stars lock to their choice as a read-only "you already rated this"
 * indicator. Not mounted for owners; renders nothing until the own-rating read resolves (so the stars
 * never flash a wrong value).
 */
export const YourRating = ({ myRating, rate, signedIn }: YourRatingProps) => {
  if (myRating === null) return null; // still loading

  // Already rated → locked read-only display (ratings can't be changed or withdrawn).
  if (myRating > 0) {
    return (
      <span className="your-rating">
        <span className="rating-meta">Your rating</span>
        <Tooltip title="You've rated this">
          {/* Wrap so Tooltip attaches to a real DOM node (rc-rate forwards an imperative handle). */}
          <span style={{ display: 'inline-block' }}>
            <ConfigProvider theme={{ components: { Rate: { starColor: MY_STAR_COLOR } } }}>
              <Rate value={myRating} disabled />
            </ConfigProvider>
          </span>
        </Tooltip>
      </span>
    );
  }

  // Not rated yet → interactive. allowClear off + a warning tooltip, since the choice is permanent.
  return (
    <span className="your-rating">
      <span className="rating-meta">Rate this</span>
      <Tooltip title={signedIn ? 'Rating is one-time and final' : 'Sign in to rate'}>
        <span style={{ display: 'inline-block' }}>
          <ConfigProvider theme={{ components: { Rate: { starColor: MY_STAR_COLOR } } }}>
            <Rate value={0} allowClear={false} onChange={rate} />
          </ConfigProvider>
        </span>
      </Tooltip>
    </span>
  );
};
