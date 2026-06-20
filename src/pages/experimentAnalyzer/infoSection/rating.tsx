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
  const { userId, expId } = useParams();

  const [rating, setRating] = useState<number | null>(null);
  const [ratingCount, setRatingCount] = useState<number | null>(null);

  const fetchRatings = async (userId: string, expId: string) => {
    const querySnapshot = await getDocs(collection(firebaseDatabase, `users/${userId}/experiments/${expId}/ratings`));
    let [count, total] = [0, 0];
    querySnapshot.forEach((doc) => {
      const rating = doc.data() as TRating;
      count += 1;
      total += rating.rating;
    });
    const r = Math.round(total / count);
    setRating(r);
    setRatingCount(total);
  };

  useEffect(() => {
    if (!userId || !expId) return;
    fetchRatings(userId, expId);
  }, [userId, expId]);

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
