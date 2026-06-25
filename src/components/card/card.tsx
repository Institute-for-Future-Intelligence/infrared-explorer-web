import { getBlob, ref } from 'firebase/storage';
import type { Timestamp } from 'firebase/firestore';
import React, { useEffect, useRef, useState } from 'react';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import {
  MoreOutlined,
  EyeOutlined,
  MessageOutlined,
  StarFilled,
  CalendarOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
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
  commentCount?: number;
  createdAt?: Timestamp | null;
  duration?: number;
}

/** Seconds → m:ss (e.g. 75 → "1:15"). */
const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

/** Firestore Timestamp → locale date string; tolerant of legacy docs missing `createdAt`. */
const formatDate = (ts?: Timestamp | null) => (ts?.toDate ? ts.toDate().toLocaleDateString() : '');

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
    commentCount,
    createdAt,
    duration,
    onOpen,
    onDelete,
    menuItems,
  }: CardProps) => {
    const [dataURL, setDataURL] = useState<any>(null);
    const [hovered, setHovered] = useState(false);
    const descRef = useRef<HTMLDivElement | null>(null);
    const nameRef = useRef<HTMLDivElement | null>(null);
    // How many description lines fit the (variable) card height, so the text is
    // clamped with a trailing "…" instead of being hard-cut mid-line.
    const [descLines, setDescLines] = useState(6);

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

    // Recompute the line clamp whenever the card (and thus its flexible
    // description area) is resized — cards stretch to fill the responsive grid.
    const DESC_LINE_HEIGHT = 16;
    useEffect(() => {
      const el = descRef.current;
      if (!el) return;
      const update = () => setDescLines(Math.max(1, Math.floor(el.clientHeight / DESC_LINE_HEIGHT)));
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }, [dataURL, description]);

    // Keep the title on a single line by shrinking its font until it fits
    // (down to a floor); below the floor the CSS ellipsis takes over. Re-runs
    // as the card resizes within the responsive grid.
    const NAME_BASE_FONT = 16;
    const NAME_MIN_FONT = 9;
    useEffect(() => {
      const el = nameRef.current;
      if (!el) return;
      const fit = () => {
        let size = NAME_BASE_FONT;
        el.style.fontSize = `${size}px`;
        while (el.scrollWidth > el.clientWidth && size > NAME_MIN_FONT) {
          size -= 1;
          el.style.fontSize = `${size}px`;
        }
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      return () => ro.disconnect();
    }, [dataURL, displayName]);

    if (!dataURL) return <></>;

    const ratingAvg = ratingCount ? ratingSum! / ratingCount : 0;
    const createdLabel = formatDate(createdAt);
    const hasDuration = typeof duration === 'number';
    const hasMeta = !!(
      author ||
      description ||
      ratingCount ||
      viewCount ||
      commentCount ||
      createdLabel ||
      hasDuration
    );

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

        {/* Hover meta overlay (experimenter / description / views · comments · rating) */}
        {hasMeta && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              padding: '34px 12px 40px',
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
            {/* Description (or an empty spacer) takes the flexible top space, pushing the
                author + metrics rows down to the bottom of the card. */}
            {description ? (
              <div
                ref={descRef}
                style={{
                  fontSize: 12,
                  lineHeight: `${DESC_LINE_HEIGHT}px`,
                  flex: 1,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: descLines,
                }}
              >
                {extractText(description)}
              </div>
            ) : (
              <div style={{ flex: 1 }} />
            )}
            {author && <div style={{ fontSize: 12, opacity: 0.85 }}>by {author}</div>}
            {/* Created date · video length. */}
            {(createdLabel || hasDuration) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, opacity: 0.8 }}>
                {createdLabel && (
                  <span title="Created">
                    <CalendarOutlined /> {createdLabel}
                  </span>
                )}
                {hasDuration && (
                  <span title="Length">
                    <ClockCircleOutlined /> {formatDuration(duration!)}
                  </span>
                )}
              </div>
            )}
            {/* Metrics: views · comments · rating (the antd Rate stars are illegible on a dark overlay). */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, opacity: 0.95 }}>
              <span title="Views">
                <EyeOutlined /> {viewCount ?? 0}
              </span>
              <span title="Comments">
                <MessageOutlined /> {commentCount ?? 0}
              </span>
              <span title="Rating" style={{ marginLeft: 'auto' }}>
                <StarFilled style={{ color: '#fadb14' }} /> {ratingCount ? ratingAvg.toFixed(1) : '–'}
                <span style={{ opacity: 0.7 }}> ({ratingCount ?? 0})</span>
              </span>
            </div>
          </div>
        )}

        <div className="card-name" ref={nameRef}>
          {extractText(displayName)}
        </div>

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
