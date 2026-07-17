import type { Timestamp } from 'firebase/firestore';
import React, { useEffect, useRef, useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  MoreOutlined,
  EyeOutlined,
  MessageOutlined,
  StarFilled,
  CalendarOutlined,
  ClockCircleOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { ExperimentSubjects, Visibility } from '../../types';
import SubjectTag from './subjectTag';
import { SUBJECT_META } from './subjectMeta';
import CardSkeleton from './cardSkeleton';
import { VisibilityBadge, visibilityLabel, visibilityMenuItems } from '../visibilityControl';
import { FeaturedBadge } from '../featureControl';
import useThumbnail from './useThumbnail';
import { formatDuration } from '../../utils/helpers';

export interface CardMeta {
  subject?: ExperimentSubjects | null;
  author?: string;
  description?: string;
  ratingSum?: number;
  ratingCount?: number;
  viewCount?: number;
  commentCount?: number;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
  duration?: number;
}

/** Firestore Timestamp → locale date string; tolerant of legacy docs missing `createdAt`. */
const formatDate = (ts?: Timestamp | null) => (ts?.toDate ? ts.toDate().toLocaleDateString() : '');

interface CardProps extends CardMeta {
  id: string;
  url: string;
  displayName: string;
  // A card's visibility tier; rendered as an icon badge only when `showVisibility` is set (owner
  // grids). Public-facing grids omit both, so the badge never appears where everything is public.
  visibility?: Visibility;
  showVisibility?: boolean;
  // Whether the experiment is featured on the site homepage; badged on owner grids (gated on the
  // same `showVisibility` owner-context signal) so the "Add to homepage showcase" action shows an effect.
  featured?: boolean;
  // When set (owner grids), the visibility badge becomes a click-to-change dropdown that calls this
  // with the picked tier. Absent → the badge is a display-only indicator.
  onVisibilityChange?: (v: Visibility) => void;
  onOpen?: (id: string) => void;
  // Makes the hover-overlay author line a link (to the author's profile page). Router-free like
  // onOpen: the caller supplies the navigation, the card only reports the click.
  onAuthorClick?: () => void;
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
    visibility,
    showVisibility,
    featured,
    onVisibilityChange,
    author,
    description,
    ratingSum,
    ratingCount,
    viewCount,
    commentCount,
    createdAt,
    updatedAt,
    duration,
    onOpen,
    onAuthorClick,
    onDelete,
    menuItems,
  }: CardProps) => {
    const dataURL = useThumbnail(url);
    const [hovered, setHovered] = useState(false);
    const descRef = useRef<HTMLDivElement | null>(null);
    // How many description lines fit the (variable) card height, so the text is
    // clamped with a trailing "…" instead of being hard-cut mid-line.
    const [descLines, setDescLines] = useState(6);

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

    // Until the thumbnail's blob resolves, hold the card's footprint with a skeleton instead of
    // rendering nothing — otherwise the grid reflows (CLS) as each card pops in.
    if (!dataURL) return <CardSkeleton />;

    const ratingAvg = ratingCount ? ratingSum! / ratingCount : 0;
    const createdLabel = formatDate(createdAt);
    const updatedLabel = formatDate(updatedAt);
    const hasDuration = typeof duration === 'number';
    const hasMeta = !!(
      author ||
      description ||
      ratingCount ||
      viewCount ||
      commentCount ||
      createdLabel ||
      updatedLabel ||
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

        {/* Top-left status row: visibility · subject tier, one aligned row. The subject tag is
            non-interactive (clicks fall through); the visibility badge re-enables pointer events for
            its hover tooltip and, on owner grids, a click-to-change dropdown. */}
        {(!!(subject && SUBJECT_META[subject]) || (showVisibility && visibility)) && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              pointerEvents: 'none',
            }}
          >
            {showVisibility && visibility && (
              <Tooltip title={visibilityLabel(visibility)}>
                {onVisibilityChange ? (
                  <span
                    onClick={(e) => e.stopPropagation()}
                    style={{ pointerEvents: 'auto', cursor: 'pointer', display: 'inline-flex' }}
                  >
                    <Dropdown
                      menu={{ items: visibilityMenuItems(visibility, onVisibilityChange) }}
                      trigger={['click']}
                      placement="bottomLeft"
                    >
                      <span style={{ display: 'inline-flex' }}>
                        <VisibilityBadge visibility={visibility} />
                      </span>
                    </Dropdown>
                  </span>
                ) : (
                  <span style={{ pointerEvents: 'auto', display: 'inline-flex' }}>
                    <VisibilityBadge visibility={visibility} />
                  </span>
                )}
              </Tooltip>
            )}
            <SubjectTag subject={subject} />
          </div>
        )}

        {/* Top-right actions row: homepage-showcase badge · options menu (or legacy delete), aligned
            with the left status row. */}
        {((showVisibility && featured) || menuItems || onDelete) && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 3,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {showVisibility && featured && <FeaturedBadge />}
            {menuItems ? (
              <div onClick={(e) => e.stopPropagation()}>
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
        )}

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
            {/* The overlay is pointer-transparent (clicks fall through to the card); the author
                link re-enables pointer events on its own line — but only while the overlay is
                actually visible, so the invisible link never hijacks a card-open tap. Focusing
                the link (keyboard) reveals the overlay so the target isn't invisible. */}
            {author && (
              <div
                style={{ fontSize: 12, opacity: 0.85, ...(onAuthorClick && hovered ? { pointerEvents: 'auto' } : {}) }}
              >
                by{' '}
                {onAuthorClick ? (
                  <span
                    role="link"
                    tabIndex={0}
                    title="View profile"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAuthorClick();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onAuthorClick();
                      }
                    }}
                    onFocus={() => setHovered(true)}
                    onBlur={() => setHovered(false)}
                    style={{ color: '#8ecbff', textDecoration: 'underline', cursor: 'pointer' }}
                  >
                    {author}
                  </span>
                ) : (
                  author
                )}
              </div>
            )}
            {/* Video length on top, then created · updated dates. */}
            {(createdLabel || updatedLabel || hasDuration) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.8 }}>
                {hasDuration && (
                  <span title="Length">
                    <ClockCircleOutlined /> {formatDuration(duration!)}
                  </span>
                )}
                {(createdLabel || updatedLabel) && (
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 14px' }}>
                    {createdLabel && (
                      <span title="Created">
                        <CalendarOutlined /> {createdLabel}
                      </span>
                    )}
                    {updatedLabel && (
                      <span title="Updated">
                        <EditOutlined /> {updatedLabel}
                      </span>
                    )}
                  </div>
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
                <StarFilled style={{ color: 'var(--ifi-heat)' }} /> {ratingCount ? ratingAvg.toFixed(1) : '–'}
                <span style={{ opacity: 0.7 }}> ({ratingCount ?? 0})</span>
              </span>
            </div>
          </div>
        )}

        <div className="card-name">{extractText(displayName)}</div>
      </div>
    );
  },
);

export default Card;
