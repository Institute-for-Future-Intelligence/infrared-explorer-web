import { useState } from 'react';
import { Play, X } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import SubjectTag from '../card/subjectTag';
import useDownloadUrl from '../card/useDownloadUrl';
import type { ShowcaseCard } from '../../utils/homeLayout';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');

// The subset of useSortable()'s return the tile needs — typed from the hook itself so it matches
// dnd-kit's DraggableAttributes / listener map without deep imports.
type Sortable = Pick<
  ReturnType<typeof useSortable>,
  'setNodeRef' | 'attributes' | 'listeners' | 'transform' | 'transition' | 'isDragging'
>;

/** One hero tile. In Curate mode it shows a pinned-rank / "Auto" badge and (when pinned) an unpin
 *  button, and — when `sortable` is supplied — is draggable to reorder. */
const HeroTile = ({
  item,
  main,
  priority,
  valueProp,
  curating,
  rank,
  pinned,
  onOpen,
  onUnpin,
  sortable,
}: {
  item: ShowcaseCard;
  main?: boolean;
  priority?: boolean;
  valueProp?: string;
  curating?: boolean;
  rank?: number;
  pinned?: boolean;
  onOpen: (id: string) => void;
  onUnpin?: (id: string) => void;
  sortable?: Sortable;
}) => {
  const url = useDownloadUrl(item.thumbnailURL);
  const title = stripHtml(item.displayName ?? '');
  const style = sortable
    ? {
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.4 : undefined,
      }
    : undefined;

  return (
    <article
      ref={sortable?.setNodeRef}
      style={style}
      className={`hero-tile${main ? ' hero-tile-main' : ''}${curating ? ' is-curating' : ''}`}
      {...(sortable?.attributes ?? {})}
      {...(sortable?.listeners ?? {})}
      // Our own semantics/handlers must win over dnd-kit's defaults (role=button, its keydown), so
      // they come after the spreads. Keyboard reordering lives in the tray, not on the tiles.
      role="link"
      tabIndex={0}
      aria-label={title}
      onClick={() => onOpen(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item.id);
        }
      }}
    >
      <div className="hero-tile-media">
        {url && (
          <img
            className="hero-tile-img"
            src={url}
            alt=""
            {...(priority ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
          />
        )}
        {curating &&
          (rank ? (
            <span className="hero-slot-badge is-pinned">Pinned #{rank}</span>
          ) : (
            <span className="hero-slot-badge">Auto</span>
          ))}
        {curating && pinned && onUnpin && (
          <button
            type="button"
            className="hero-unpin"
            title="Unpin from hero"
            aria-label="Unpin from hero"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onUnpin(item.id);
            }}
          >
            <X size={15} strokeWidth={2.25} aria-hidden />
          </button>
        )}
      </div>
      <div className="hero-tile-body">
        <div className="hero-tile-badge">
          <SubjectTag subject={item.subject} />
          {main && !curating && <span className="hero-featured">FEATURED</span>}
        </div>
        <h3 className="hero-tile-title">{title}</h3>
        {main && valueProp && <p className="hero-tile-valueprop">{valueProp}</p>}
        {item.author && <p className="hero-tile-author">{item.author}</p>}
        {main && (
          <button
            type="button"
            className="hero-tile-cta"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(item.id);
            }}
          >
            <Play size={15} fill="currentColor" strokeWidth={0} aria-hidden />
            Watch experiment
          </button>
        )}
      </div>
    </article>
  );
};

/** Draggable wrapper: binds one tile to dnd-kit sortable. */
const SortableHeroTile = (props: {
  item: ShowcaseCard;
  main?: boolean;
  rank?: number;
  pinned?: boolean;
  onOpen: (id: string) => void;
  onUnpin: (id: string) => void;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.item.id });
  return (
    <HeroTile {...props} curating sortable={{ setNodeRef, attributes, listeners, transform, transition, isDragging }} />
  );
};

const PlainHeroBoard = ({
  items,
  onOpen,
  valueProp,
}: {
  items: ShowcaseCard[];
  onOpen: (id: string) => void;
  valueProp?: string;
}) => {
  const [main, ...rest] = items;
  return (
    <section className="hero-board" aria-label="Featured experiments">
      <HeroTile item={main} main priority valueProp={valueProp} onOpen={onOpen} />
      {rest.slice(0, 4).map((item) => (
        <HeroTile key={item.id} item={item} onOpen={onOpen} />
      ))}
    </section>
  );
};

/** Curate mode: the hero tiles become drag-sortable (dropping rewrites the whole visible order as
 *  pins — "what you arrange is what everyone sees"). Pinned tiles show their rank + an unpin button;
 *  algorithm-filled slots show "Auto". */
const CuratableHeroBoard = ({
  items,
  heroIds,
  onOpen,
  onReorder,
  onUnpin,
}: {
  items: ShowcaseCard[];
  heroIds: string[];
  onOpen: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onUnpin: (id: string) => void;
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Pointer only (8px activation so a plain click still opens the tile); keyboard reordering is in
  // the tray.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const ids = items.map((i) => i.id);
  const rankOf = (id: string) => {
    const i = heroIds.indexOf(id);
    return i >= 0 ? i + 1 : undefined;
  };

  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (over && active.id !== over.id) {
      onReorder(arrayMove(ids, ids.indexOf(active.id as string), ids.indexOf(over.id as string)));
    }
  };

  const activeItem = items.find((i) => i.id === activeId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(e) => setActiveId(e.active.id as string)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <section className="hero-board is-curating" aria-label="Featured experiments (drag to reorder)">
          {items.map((item, i) => (
            <SortableHeroTile
              key={item.id}
              item={item}
              main={i === 0}
              rank={rankOf(item.id)}
              pinned={heroIds.includes(item.id)}
              onOpen={onOpen}
              onUnpin={onUnpin}
            />
          ))}
        </section>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeItem ? <div className="hero-drag-proxy">{stripHtml(activeItem.displayName ?? '')}</div> : null}
      </DragOverlay>
    </DndContext>
  );
};

/**
 * Featured hero board: 1 big tile + up to 4 small ones. Not an auto-rotating banner (K12 banner
 * blindness) — a static editorial board. The main tile is "left image, right text" so its title
 * sits on a solid night panel, not on the thumbnail. In staff Curate mode the tiles become
 * drag-sortable and gain pin/unpin affordances.
 */
const HeroBoard = ({
  items,
  onOpen,
  valueProp,
  curating,
  heroIds = [],
  onReorder,
  onUnpin,
}: {
  items: ShowcaseCard[];
  onOpen: (id: string) => void;
  valueProp?: string;
  curating?: boolean;
  heroIds?: string[];
  onReorder?: (ids: string[]) => void;
  onUnpin?: (id: string) => void;
}) => {
  if (items.length === 0) return null;
  if (curating && onReorder && onUnpin) {
    return (
      <CuratableHeroBoard items={items} heroIds={heroIds} onOpen={onOpen} onReorder={onReorder} onUnpin={onUnpin} />
    );
  }
  return <PlainHeroBoard items={items} onOpen={onOpen} valueProp={valueProp} />;
};

export default HeroBoard;
