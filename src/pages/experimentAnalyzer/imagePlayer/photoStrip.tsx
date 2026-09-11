import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Tooltip } from 'antd';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import useThumbnail from '../../../components/card/useThumbnail';
import { photoPlaces } from '../../../utils/photoOrder';

/**
 * The photo browser's transport — what a PHOTO SET (sourceType 'photos') shows in place of the
 * recording's play / scrub control bar. A set is a handful of separate shots, not a clip, so there is
 * nothing to play and no time to scrub: the strip is a filmstrip of every photo (click to show), a
 * prev / next pair with a "Photo k of N" counter, and a caption line for the shown photo — its title,
 * if the capture app had one, its capture time, and how long after the set's first shot it was taken.
 *
 * The strip runs in the set's viewing order (utils/photoOrder): "Photo k" and prev / next count places
 * in that order, while `index` and everything handed back stay capture slots. The owner can drag a
 * thumbnail to a new place (mouse, a long press on touch, or Space + arrows); the new order goes up
 * through `onReorder` and the player persists it.
 *
 * Thumbnails are the set's own data_N.png renders, fetched through the card thumbnail hook (one
 * Storage read each, memoised in the shared image cache — the same blob the main frame is decoded
 * from is not reused because the player caches frames as data URLs per view mode, not by path).
 */
interface Props {
  recordingId: string;
  photoCount: number;
  /** The viewing order: order[p] is the 0-based capture slot shown at place p (a full permutation). */
  order: number[];
  /** Capture slot of the shown photo (the player's frame index). */
  index: number;
  onSelect: (index: number) => void;
  /** Given only when the viewer may reorder the set (its owner): the new order, after a drag. */
  onReorder?: (order: number[]) => void;
  /** Capture instant per photo, epoch ms (0 = unknown). */
  capturedAt?: number[];
  /** Caption per photo ('' = none). */
  titles?: string[];
  /** Whether each photo carries temperature data; absent = all do. A picture-only photo says so in its caption. */
  thermal?: boolean[];
}

// dnd-kit ids: the 1-based capture number (data_N.png's N) — stable across reorders, and never 0, which
// the library can read as "no id".
const idOf = (slot: number): UniqueIdentifier => slot + 1;
const slotOf = (id: UniqueIdentifier): number => Number(id) - 1;

// The strip is a single row: a dragged thumbnail slides along it, never up into the frame or out of it.
const alongTheStrip: Modifier = ({ transform }) => ({ ...transform, y: 0 });
// Scroll the strip, never the page, when a drag nears an edge.
const AUTO_SCROLL = { threshold: { x: 0.2, y: 0 } };

// Mouse drags after a few px, so a click still shows the photo; touch after a long press, so a swipe
// still scrolls the strip; the keyboard picks up with Space (Enter keeps showing the photo), moves with
// the arrows — the sensor claims them, so the player's ← / → paging leaves them alone — and drops with
// Space or Enter.
const MOUSE_DRAG = { activationConstraint: { distance: 5 } };
const TOUCH_DRAG = { activationConstraint: { delay: 250, tolerance: 5 } };
const KEYBOARD_DRAG = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
};

// The subset of useSortable()'s return a thumbnail needs (typed from the hook, as heroBoard does).
type Sortable = Pick<
  ReturnType<typeof useSortable>,
  'setNodeRef' | 'attributes' | 'listeners' | 'transform' | 'transition' | 'isDragging'
>;

const PhotoThumb = ({
  recordingId,
  slot,
  place,
  active,
  onClick,
  sortable,
}: {
  recordingId: string;
  slot: number;
  place: number;
  active: boolean;
  onClick: () => void;
  sortable?: Sortable;
}) => {
  const dataURL = useThumbnail(`recordings/${recordingId}/data_${slot + 1}.png`);
  const ref = useRef<HTMLButtonElement | null>(null);
  // One stable ref for both us and dnd-kit: an inline one would detach and re-attach the node (and its
  // resize observer) on every render of a drag.
  const setSortableNode = sortable?.setNodeRef;
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      ref.current = el;
      setSortableNode?.(el);
    },
    [setSortableNode],
  );
  // Keep the shown photo in view as the user pages with the keys / arrows; 'nearest' so a strip that
  // already shows it does not jump.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  const className = ['photo-strip-thumb', active && 'active', sortable?.isDragging && 'is-dragging']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      // dnd-kit's attributes / listeners first, so the button's own semantics and click win.
      {...(sortable?.attributes ?? {})}
      {...(sortable?.listeners ?? {})}
      ref={setRef}
      type="button"
      className={className}
      style={
        sortable
          ? { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }
          : undefined
      }
      aria-label={`Photo ${place + 1}`}
      aria-current={active ? 'true' : undefined}
      title={sortable ? 'Drag to reorder' : undefined}
      onClick={onClick}
    >
      {dataURL && <img src={dataURL} alt="" draggable={false} />}
    </button>
  );
};

/** A thumbnail bound to the strip's sortable list (the owner's strip only). */
const SortablePhotoThumb = (props: Omit<Parameters<typeof PhotoThumb>[0], 'sortable'>) => {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: idOf(props.slot),
  });
  return <PhotoThumb {...props} sortable={{ setNodeRef, attributes, listeners, transform, transition, isDragging }} />;
};

/** "+m:ss" elapsed since the first photo; '' when either time is unknown. */
const formatOffset = (ms: number, firstMs: number): string => {
  if (!(ms > 0) || !(firstMs > 0) || ms < firstMs) return '';
  const total = Math.round((ms - firstMs) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `+${m}:${String(s).padStart(2, '0')}`;
};

const PhotoStrip = ({
  recordingId,
  photoCount,
  order,
  index,
  onSelect,
  onReorder,
  capturedAt,
  titles,
  thermal,
}: Props) => {
  const places = useMemo(() => photoPlaces(order), [order]);
  const place = places[index] ?? 0;
  const atStart = place <= 0;
  const atEnd = place >= photoCount - 1;
  const title = titles?.[index]?.trim() ?? '';
  const takenMs = capturedAt?.[index] ?? 0;
  // The offset counts from the set's first SHOT, not from whichever photo the owner put first.
  const firstMs = Math.min(...(capturedAt ?? []).filter((ms) => ms > 0));
  const taken = takenMs > 0 ? new Date(takenMs).toLocaleString() : '';
  const offset = takenMs > firstMs ? formatOffset(takenMs, firstMs) : '';
  const noData = thermal?.[index] === false ? 'picture only' : '';
  const caption = [title, taken, offset, noData].filter(Boolean).join(' · ');

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_DRAG),
    useSensor(TouchSensor, TOUCH_DRAG),
    useSensor(KeyboardSensor, KEYBOARD_DRAG),
  );
  const ids = useMemo(() => order.map(idOf), [order]);
  // What a screen reader hears, in the strip's own photo numbers (dnd-kit's defaults read out the ids).
  const accessibility = useMemo(() => {
    const placeOfId = (id: UniqueIdentifier) => (places[slotOf(id)] ?? 0) + 1;
    const announcements: Announcements = {
      onDragStart: ({ active }) => `Picked up photo ${placeOfId(active.id)}.`,
      onDragOver: ({ active, over }) =>
        over ? `Photo ${placeOfId(active.id)} is over place ${placeOfId(over.id)}.` : undefined,
      onDragEnd: ({ active, over }) =>
        over ? `Photo ${placeOfId(active.id)} moved to place ${placeOfId(over.id)}.` : undefined,
      onDragCancel: ({ active }) => `Photo ${placeOfId(active.id)} left where it was.`,
    };
    return {
      announcements,
      screenReaderInstructions: {
        draggable:
          'To move this photo, press Space, use the left and right arrow keys to choose its place, then press Space again to drop it or Escape to cancel.',
      },
    };
  }, [places]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!onReorder || !over || active.id === over.id) return;
    const from = places[slotOf(active.id)];
    const to = places[slotOf(over.id)];
    if (from === undefined || to === undefined) return;
    onReorder(arrayMove(order, from, to));
  };

  const sortable = !!onReorder && photoCount > 1;
  const thumbs = order.map((slot, p) => {
    const props = {
      recordingId,
      slot,
      place: p,
      active: slot === index,
      onClick: () => onSelect(slot),
    };
    return sortable ? <SortablePhotoThumb key={slot} {...props} /> : <PhotoThumb key={slot} {...props} />;
  });

  return (
    <div className="photo-strip" role="group" aria-label="Photos in this set">
      <div className="photo-strip-head">
        <button
          type="button"
          className="photo-strip-nav"
          title="Previous photo (←)"
          aria-label="Previous photo"
          disabled={atStart}
          onClick={() => !atStart && onSelect(order[place - 1])}
        >
          ‹
        </button>
        <span className="photo-strip-counter">
          Photo {place + 1} of {photoCount}
        </span>
        <button
          type="button"
          className="photo-strip-nav"
          title="Next photo (→)"
          aria-label="Next photo"
          disabled={atEnd}
          onClick={() => !atEnd && onSelect(order[place + 1])}
        >
          ›
        </button>
        {caption && (
          <Tooltip title={caption} placement="top">
            <span className="photo-strip-caption">{caption}</span>
          </Tooltip>
        )}
      </div>
      {sortable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[alongTheStrip]}
          autoScroll={AUTO_SCROLL}
          accessibility={accessibility}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
            <div className="photo-strip-film is-sortable">{thumbs}</div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="photo-strip-film">{thumbs}</div>
      )}
    </div>
  );
};

export default PhotoStrip;
