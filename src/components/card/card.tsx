import { getBlob, ref } from 'firebase/storage';
import React, { useEffect, useState } from 'react';
import { Dropdown, Rate } from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined, EyeOutlined } from '@ant-design/icons';
import { firebaseStorage } from '../../services/firebase';
import useCommonStore from '../../stores/common';
import { ExperimentSubjects } from '../../types';
import SubjectTag from './subjectTag';

export interface CardMeta {
  subject?: ExperimentSubjects | null;
  author?: string;
  description?: string;
  ratingSum?: number;
  ratingCount?: number;
  viewCount?: number;
}

interface CardProps extends CardMeta {
  id: string;
  url: string;
  displayName: string;
  onOpen?: (id: string) => void;
  onDelete?: (id: string) => void;
  menuItems?: MenuProps['items'];
}

/** Strip any HTML tags a denormalized title might carry, so the banner shows plain text. */
const extractText = (html: string) => html.replace(/<[^>]*>/g, '');

const Card = React.memo(
  ({
    id,
    url,
    displayName,
    subject,
    author,
    description,
    ratingSum,
    ratingCount,
    viewCount,
    onOpen,
    onDelete,
    menuItems,
  }: CardProps) => {
    const [dataURL, setDataURL] = useState<any>(null);
    const [hovered, setHovered] = useState(false);

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
        setDataURL(useCommonStore.getState().imageCache.get(url));
      } else {
        load(url);
      }
    }, [url]);

    if (!dataURL) return <></>;

    const ratingAvg = ratingCount ? ratingSum! / ratingCount : 0;
    const hasMeta = !!(author || description || ratingCount || viewCount);

    return (
      <div
        className="card"
        style={{ position: 'relative', cursor: onOpen ? 'pointer' : 'default' }}
        onClick={() => onOpen?.(id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <img src={dataURL} style={{ objectFit: 'contain', width: '100%', height: '100%' }} />

        <SubjectTag subject={subject} />

        {/* Hover meta overlay (experimenter / description / rating / views) */}
        {hasMeta && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              background: 'rgba(0,0,0,0.72)',
              color: 'white',
              opacity: hovered ? 1 : 0,
              transition: 'opacity 0.2s',
              pointerEvents: 'none',
              overflow: 'hidden',
            }}
          >
            {author && <div style={{ fontSize: 12, opacity: 0.85 }}>by {author}</div>}
            {description && (
              <div style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {extractText(description).slice(0, 200)}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <Rate allowHalf disabled value={ratingAvg} style={{ fontSize: 12 }} />
              <span>({ratingCount ?? 0})</span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              <EyeOutlined /> {viewCount ?? 0}
            </div>
          </div>
        )}

        <div className="card-name">{extractText(displayName)}</div>

        {menuItems ? (
          <div style={{ position: 'absolute', top: 4, right: 4 }} onClick={(e) => e.stopPropagation()}>
            <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
              <MoreOutlined
                title="Options"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'rgba(0,0,0,0.55)',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              />
            </Dropdown>
          </div>
        ) : (
          onDelete && (
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
          )
        )}
      </div>
    );
  },
);

export default Card;
