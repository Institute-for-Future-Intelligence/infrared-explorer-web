import { useEffect, useRef } from 'react';
import { Tooltip } from 'antd';
import useThumbnail from '../../../components/card/useThumbnail';

/**
 * The photo browser's transport — what a PHOTO SET (sourceType 'photos') shows in place of the
 * recording's play / scrub control bar. A set is a handful of separate shots, not a clip, so there is
 * nothing to play and no time to scrub: the strip is a filmstrip of every photo (click to show), a
 * prev / next pair with a "Photo k of N" counter, and a caption line for the shown photo — its title,
 * if the capture app had one, its capture time, and how long after the first photo it was taken.
 *
 * Thumbnails are the set's own data_N.png renders, fetched through the card thumbnail hook (one
 * Storage read each, memoised in the shared image cache — the same blob the main frame is decoded
 * from is not reused because the player caches frames as data URLs per view mode, not by path).
 */
interface Props {
  recordingId: string;
  photoCount: number;
  /** 0-based index of the shown photo (the player's frame index). */
  index: number;
  onSelect: (index: number) => void;
  /** Capture instant per photo, epoch ms (0 = unknown). */
  capturedAt?: number[];
  /** Caption per photo ('' = none). */
  titles?: string[];
  /** Whether each photo carries temperature data; absent = all do. A picture-only photo says so in its caption. */
  thermal?: boolean[];
}

const PhotoThumb = ({
  recordingId,
  n,
  active,
  onClick,
}: {
  recordingId: string;
  n: number;
  active: boolean;
  onClick: () => void;
}) => {
  const dataURL = useThumbnail(`recordings/${recordingId}/data_${n}.png`);
  const ref = useRef<HTMLButtonElement>(null);
  // Keep the shown photo in view as the user pages with the keys / arrows; 'nearest' so a strip that
  // already shows it does not jump.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      className={active ? 'photo-strip-thumb active' : 'photo-strip-thumb'}
      aria-label={`Photo ${n}`}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
    >
      {dataURL && <img src={dataURL} alt="" draggable={false} />}
    </button>
  );
};

/** "+m:ss" elapsed since the first photo; '' when either time is unknown. */
const formatOffset = (ms: number, firstMs: number): string => {
  if (!(ms > 0) || !(firstMs > 0) || ms < firstMs) return '';
  const total = Math.round((ms - firstMs) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `+${m}:${String(s).padStart(2, '0')}`;
};

const PhotoStrip = ({ recordingId, photoCount, index, onSelect, capturedAt, titles, thermal }: Props) => {
  const atStart = index <= 0;
  const atEnd = index >= photoCount - 1;
  const title = titles?.[index]?.trim() ?? '';
  const takenMs = capturedAt?.[index] ?? 0;
  const firstMs = capturedAt?.[0] ?? 0;
  const taken = takenMs > 0 ? new Date(takenMs).toLocaleString() : '';
  const offset = index > 0 ? formatOffset(takenMs, firstMs) : '';
  const noData = thermal?.[index] === false ? 'picture only' : '';
  const caption = [title, taken, offset, noData].filter(Boolean).join(' · ');

  return (
    <div className="photo-strip" role="group" aria-label="Photos in this set">
      <div className="photo-strip-head">
        <button
          type="button"
          className="photo-strip-nav"
          title="Previous photo (←)"
          aria-label="Previous photo"
          disabled={atStart}
          onClick={() => !atStart && onSelect(index - 1)}
        >
          ‹
        </button>
        <span className="photo-strip-counter">
          Photo {index + 1} of {photoCount}
        </span>
        <button
          type="button"
          className="photo-strip-nav"
          title="Next photo (→)"
          aria-label="Next photo"
          disabled={atEnd}
          onClick={() => !atEnd && onSelect(index + 1)}
        >
          ›
        </button>
        {caption && (
          <Tooltip title={caption} placement="top">
            <span className="photo-strip-caption">{caption}</span>
          </Tooltip>
        )}
      </div>
      <div className="photo-strip-film">
        {Array.from({ length: photoCount }, (_, i) => (
          <PhotoThumb key={i} recordingId={recordingId} n={i + 1} active={i === index} onClick={() => onSelect(i)} />
        ))}
      </div>
    </div>
  );
};

export default PhotoStrip;
