import { getBlob, ref } from 'firebase/storage';
import React, { useEffect, useState } from 'react';
import { firebaseStorage } from '../../services/firebase';
import useCommonStore from '../../stores/common';

interface CardProps {
  id: string;
  url: string;
  displayName: string;
  onDelete?: (id: string) => void;
}

const Card = React.memo(({ id, url, displayName, onDelete }: CardProps) => {
  const [dataURL, setDataURL] = useState<any>(null);

  const load = async (url: string) => {
    try {
      const blob = await getBlob(ref(firebaseStorage, url));
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        if (res) {
          setDataURL(res);
          useCommonStore.getState().setImageCache(url, res);
        }
      };
      reader.readAsDataURL(blob);
    } catch (e) {}
  };

  useEffect(() => {
    if (useCommonStore.getState().imageCache.has(url)) {
      const res = useCommonStore.getState().imageCache.get(url);
      setDataURL(res);
    } else {
      load(url);
    }
  }, [url]);

  if (!dataURL) return <></>;
  return (
    <div className="card" style={{ position: 'relative' }}>
      <img id={id} src={dataURL} />
      <div className="card-name">{displayName}</div>
      {onDelete && (
        <button
          title="Move to trash"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 22,
            height: 22,
            padding: 0,
            border: 'none',
            borderRadius: '50%',
            background: 'rgba(0,0,0,0.55)',
            color: 'white',
            lineHeight: '20px',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      )}
    </div>
  );
});

export default Card;
