import { Rate } from 'antd';
import { collection, getDocs } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { TRating } from '../../../types';
import { useEffect, useState } from 'react';

interface RatingProps {
  viewCount: number;
}

const Rating = ({ viewCount }: RatingProps) => {
  const { expId } = useParams();

  const [rating, setRating] = useState<number | null>(null);
  const [ratingCount, setRatingCount] = useState<number | null>(null);

  const fetchRatings = async (expId: string) => {
    const querySnapshot = await getDocs(collection(firebaseDatabase, `experiments/${expId}/ratings`));
    let [count, total] = [0, 0];
    querySnapshot.forEach((doc) => {
      const rating = doc.data() as TRating;
      count += 1;
      total += rating.rating;
    });
    setRating(count ? Math.round(total / count) : 0);
    setRatingCount(count); // number of ratings, not the sum of stars
  };

  useEffect(() => {
    if (!expId) return;
    fetchRatings(expId);
  }, [expId]);

  if (rating === null || ratingCount === null) return null;

  return (
    <div className="rating-wrapper">
      <Rate value={rating} />
      <span>{` ${viewCount} view${viewCount > 1 ? 's' : ''}`}</span>
      <span>{` ${ratingCount} rating${ratingCount > 1 ? 's' : ''}`}</span>
    </div>
  );
};

export default Rating;
