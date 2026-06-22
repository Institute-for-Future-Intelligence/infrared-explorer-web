import { useEffect, useState } from 'react';
import { List } from 'antd';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { ExperimentDoc } from '../../../types';

interface Props {
  recordingId: string;
  currentId: string;
}

type RelatedItem = ExperimentDoc & { id: string };

/** Sibling experiments derived from the same recording (public/unlisted only, current excluded). */
const RelatedList = ({ recordingId, currentId }: Props) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<RelatedItem[]>([]);

  useEffect(() => {
    const fetchRelated = async () => {
      // The visibility filter keeps the query rule-satisfiable (read rule allows public/unlisted).
      const q = query(
        collection(firebaseDatabase, 'experiments'),
        where('recordingId', '==', recordingId),
        where('visibility', 'in', ['public', 'unlisted']),
      );
      const snap = await getDocs(q);
      setItems(snap.docs.filter((d) => d.id !== currentId).map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id })));
    };
    fetchRelated();
  }, [recordingId, currentId]);

  return (
    <List
      locale={{ emptyText: 'No related analyses' }}
      dataSource={items}
      renderItem={(item) => (
        <List.Item
          style={{ cursor: 'pointer' }}
          onClick={() => navigate(`/experiments/${item.id}`)}
          actions={[<a key="open">Open</a>]}
        >
          <List.Item.Meta title={item.displayName} description={`${item.author} · ${item.date}`} />
        </List.Item>
      )}
    />
  );
};

export default RelatedList;
