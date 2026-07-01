import { Rate, Tooltip } from 'antd';
import { collection, doc, getDocs, setDoc } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { TRating } from '../../../types';
import { useEffect, useState } from 'react';
import useCommonStore from '../../../stores/common';
import { signIn } from '../../../services/auth';

/**
 * Shared rating state for one experiment: the rounded average (`rating`), the number of ratings
 * (`ratingCount`), and a `rate()` action. The passive counts are shown up top with the facts while
 * the interactive stars live in the bottom action bar — both read from this single fetch so they
 * never drift. `rating`/`ratingCount` are null until the first fetch resolves.
 */
export const useRatings = () => {
  const { expId } = useParams();
  const user = useCommonStore((state) => state.user);

  const [rating, setRating] = useState<number | null>(null); // rounded, for the star display
  const [average, setAverage] = useState<number | null>(null); // precise mean, for the numeric score
  const [ratingCount, setRatingCount] = useState<number | null>(null);

  const fetchRatings = async (id: string) => {
    const querySnapshot = await getDocs(collection(firebaseDatabase, `experiments/${id}/ratings`));
    let [count, total] = [0, 0];
    querySnapshot.forEach((d) => {
      const r = d.data() as TRating;
      count += 1;
      total += r.rating;
    });
    setRating(count ? Math.round(total / count) : 0);
    setAverage(count ? total / count : 0);
    setRatingCount(count); // number of ratings, not the sum of stars
  };

  useEffect(() => {
    if (!expId) return;
    fetchRatings(expId);
  }, [expId]);

  // One rating per user: doc id == mongoId, payload is just { rating } (matches the rules whitelist).
  // A signed-out user clicking the stars gets the sign-in popup (not a silent no-op), then can rate.
  // Guard value >= 1: the rules reject 0 (rating must be 1-5), and even with allowClear off a
  // stray 0 must never reach setDoc, or it surfaces as a permission error.
  const rate = async (value: number) => {
    if (!user) {
      signIn().catch((e) => console.error('sign-in failed', e));
      return;
    }
    if (!expId || value < 1) return;
    try {
      await setDoc(doc(firebaseDatabase, `experiments/${expId}/ratings/${user.id}`), { rating: value });
      await fetchRatings(expId);
    } catch (e) {
      console.error('failed to save rating', e);
    }
  };

  return { rating, average, ratingCount, rate, signedIn: !!user };
};

interface RatingStarsProps {
  rating: number;
  rate: (value: number) => void;
  signedIn: boolean;
}

/** Just the interactive stars (shows the average; clicking rates, or prompts sign-in if signed out). */
export const RatingStars = ({ rating, rate, signedIn }: RatingStarsProps) => (
  // Wrap Rate in a span so Tooltip attaches its ref to a real DOM node: Rate (rc-rate) forwards an
  // imperative handle, not a DOM element, so an unwrapped child makes Tooltip fall back to the
  // deprecated findDOMNode. inline-block keeps the stars sized to their content.
  <Tooltip title={signedIn ? '' : 'Sign in to rate'}>
    <span style={{ display: 'inline-block' }}>
      <Rate value={rating} allowClear={false} onChange={rate} />
    </span>
  </Tooltip>
);
