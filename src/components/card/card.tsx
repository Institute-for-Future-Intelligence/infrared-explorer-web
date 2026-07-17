import type { Timestamp } from 'firebase/firestore';
import React, { useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { Eye, Star } from 'lucide-react';
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

// Relative date ("3 weeks ago") for the byline. Locale is pinned to 'en' (the UI language) so a
// visitor's browser locale can't surface a stray "3周前" inside an English page; the absolute date
// rides along in the element's title for anyone who needs it.
const REL_FMT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const REL_DIVS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];
const formatRelative = (ts?: Timestamp | null): string => {
  if (!ts?.toDate) return '';
  const secs = (ts.toDate().getTime() - Date.now()) / 1000; // negative = in the past
  for (const [unit, size] of REL_DIVS) {
    if (Math.abs(secs) >= size) return REL_FMT.format(Math.round(secs / size), unit);
  }
  return 'just now';
};

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
  // Makes the byline author a link (to the author's profile page). Router-free like onOpen: the
  // caller supplies the navigation, the card only reports the click.
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
    createdAt,
    updatedAt,
    duration,
    onOpen,
    onAuthorClick,
    onDelete,
    menuItems,
  }: CardProps) => {
    const dataURL = useThumbnail(url);
    // Portrait thumbnails fill the 3:4 canvas (object-fit:cover, the common case today). A landscape
    // frame would be cropped to ~half by cover, so on load we detect it and switch that card to
    // "heat-glow" fill: the frame is contained, letterbox bars filled by the same image blurred +
    // dimmed. Science content is never cropped (thermal edges carry the scale/readouts). The media
    // box stays 3:4 either way, so the toggle causes no layout shift.
    const [landscape, setLandscape] = useState(false);

    // Until the thumbnail's blob resolves, hold the card's footprint with a skeleton instead of
    // rendering nothing — otherwise the grid reflows (CLS) as each card pops in.
    if (!dataURL) return <CardSkeleton />;

    const ratingAvg = ratingCount ? ratingSum! / ratingCount : 0;
    // Owner grids pass updatedAt (showUpdated); public grids pass only createdAt. Show one date.
    const dateLabel = updatedAt ? formatRelative(updatedAt) : formatRelative(createdAt);
    const dateTitle = updatedAt ? `Updated ${formatDate(updatedAt)}` : `Created ${formatDate(createdAt)}`;
    const hasStats = !!ratingCount || typeof viewCount === 'number';
    const hasBadgeRow = !!(subject && SUBJECT_META[subject]) || (showVisibility && visibility);
    const hasActionRow = (showVisibility && featured) || !!menuItems || !!onDelete;

    return (
      <article
        className="card"
        onClick={() => onOpen?.(id)}
        tabIndex={onOpen ? 0 : undefined}
        role={onOpen ? 'link' : undefined}
        aria-label={extractText(displayName)}
        onKeyDown={(e) => {
          if (onOpen && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onOpen(id);
          }
        }}
        style={{ cursor: onOpen ? 'pointer' : 'default' }}
      >
        <div className={`card-media${landscape ? ' is-landscape' : ''}`}>
          {/* Heat-glow fill: same image, blurred + dimmed, shown only behind a letterboxed landscape
              frame (display:none otherwise, so no cost in the portrait common case). */}
          <img className="card-media-glow" src={dataURL} alt="" aria-hidden />
          <img
            className="card-media-img"
            src={dataURL}
            alt=""
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > el.naturalHeight * 1.1) setLandscape(true);
            }}
          />

          {/* Top-left: visibility (owner) · subject, one aligned row. The subject tag is
              non-interactive; the visibility badge re-enables pointer events for its tooltip and,
              on owner grids, a click-to-change dropdown. */}
          {hasBadgeRow && (
            <div className="card-corner card-corner-tl">
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

          {/* Top-right: homepage-showcase badge · options menu (or legacy delete). */}
          {hasActionRow && (
            <div className="card-corner card-corner-tr">
              {showVisibility && featured && <FeaturedBadge />}
              {menuItems ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
                    <MoreOutlined title="Options" className="card-menu-btn" />
                  </Dropdown>
                </div>
              ) : (
                onDelete && (
                  <button
                    title="Move to trash"
                    className="card-menu-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(id);
                    }}
                  >
                    ×
                  </button>
                )
              )}
            </div>
          )}

          {/* Bottom-right duration readout (mono) — visible on the card front, no hover needed. */}
          {typeof duration === 'number' && <span className="card-duration">{formatDuration(duration)}</span>}

          {/* Hover: viewfinder corners + a description scrim over the lower half of the media. Both
              are CSS-driven (:hover / :focus-visible on the card), so no JS hover state. */}
          <div className="card-viewfinder" aria-hidden />
          {description && (
            <div className="card-desc">
              <p>{extractText(description)}</p>
            </div>
          )}
        </div>

        {/* Info area below the media — always visible, so touch users see the metadata the old
            hover overlay hid. */}
        <div className="card-info">
          <h3 className="card-title">{extractText(displayName)}</h3>
          {(author || dateLabel) && (
            <p className="card-byline">
              {author &&
                (onAuthorClick ? (
                  <span
                    role="link"
                    tabIndex={0}
                    title="View profile"
                    className="card-author-link"
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
                  >
                    {author}
                  </span>
                ) : (
                  author
                ))}
              {author && dateLabel && <span className="card-byline-sep"> · </span>}
              {dateLabel && <span title={dateTitle}>{dateLabel}</span>}
            </p>
          )}
          {hasStats && (
            <p className="card-stats">
              <span title="Rating" className="card-stat">
                <Star size={13} className="card-stat-star" aria-hidden />
                <span className="mono">
                  {ratingCount ? ratingAvg.toFixed(1) : '–'} ({ratingCount ?? 0})
                </span>
              </span>
              <span title="Views" className="card-stat">
                <Eye size={13} strokeWidth={1.75} aria-hidden />
                <span className="mono">{viewCount ?? 0}</span>
              </span>
            </p>
          )}
        </div>
      </article>
    );
  },
);

export default Card;
