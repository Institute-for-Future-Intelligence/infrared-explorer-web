import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Move, Play, X } from 'lucide-react';
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
import type { HeroFocus } from '../../services/homeConfig';

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');

// The subset of useSortable()'s return the tile needs — typed from the hook itself so it matches
// dnd-kit's DraggableAttributes / listener map without deep imports.
type Sortable = Pick<
  ReturnType<typeof useSortable>,
  'setNodeRef' | 'attributes' | 'listeners' | 'transform' | 'transition' | 'isDragging'
>;

const objectPosition = (f?: HeroFocus) => (f ? `${f.x}% ${f.y}%` : undefined);

/**
 * Reposition overlay over a tile's image: dragging pans the cover-fit thumbnail (object-position) so
 * staff choose which part of it the tile shows. Only the axis the image overflows on moves. The pan
 * is local while dragging and committed on release, so the page doesn't re-render per pointer move.
 */
const ReframeOverlay = ({
  imgRef,
  focus,
  onPreview,
  onCommit,
  onDone,
}: {
  imgRef: RefObject<HTMLImageElement | null>;
  focus: HeroFocus;
  onPreview: (f: HeroFocus | null) => void;
  onCommit: (f: HeroFocus | null) => void;
  onDone: () => void;
}) => {
  const drag = useRef<{ px: number; py: number; f: HeroFocus; ox: number; oy: number; last: HeroFocus } | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation(); // keep dnd-kit's reorder drag (bound on the tile) out of it
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const bw = img.clientWidth;
    const bh = img.clientHeight;
    const scale = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      px: e.clientX,
      py: e.clientY,
      f: focus,
      ox: img.naturalWidth * scale - bw,
      oy: img.naturalHeight * scale - bh,
      last: focus,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // Dragging the picture right reveals more of its left side → a smaller x%.
    const pan = (start: number, delta: number, overflow: number) =>
      overflow > 0.5 ? Math.round(Math.min(100, Math.max(0, start - (delta / overflow) * 100))) : start;
    d.last = { x: pan(d.f.x, e.clientX - d.px, d.ox), y: pan(d.f.y, e.clientY - d.py, d.oy) };
    onPreview(d.last);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) onCommit(d.last);
  };

  return (
    <div
      className="hero-reframe"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onDone();
      }}
    >
      <span className="hero-reframe-hint">
        <Move size={14} strokeWidth={2} aria-hidden />
        Drag to reposition
      </span>
      <div className="hero-reframe-actions" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="hero-reframe-btn"
          onClick={(e) => {
            e.stopPropagation();
            onCommit(null);
          }}
        >
          Center
        </button>
        <button
          type="button"
          className="hero-reframe-btn is-primary"
          autoFocus
          onClick={(e) => {
            e.stopPropagation();
            onDone();
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
};

/** One hero tile. In Curate mode it shows a pinned-rank / "Auto" badge, a reposition-image button
 *  and (when pinned) an unpin button, and — when `sortable` is supplied — is draggable to reorder. */
const HeroTile = ({
  item,
  main,
  priority,
  valueProp,
  curating,
  rank,
  pinned,
  focus,
  onOpen,
  onUnpin,
  onFocusChange,
  sortable,
}: {
  item: ShowcaseCard;
  main?: boolean;
  priority?: boolean;
  valueProp?: string;
  curating?: boolean;
  rank?: number;
  pinned?: boolean;
  focus?: HeroFocus;
  onOpen: (id: string) => void;
  onUnpin?: (id: string) => void;
  onFocusChange?: (id: string, focus: HeroFocus | null) => void;
  sortable?: Sortable;
}) => {
  const url = useDownloadUrl(item.thumbnailURL);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [reframing, setReframing] = useState(false);
  // A pan in progress overrides the stored `focus` until it's committed on release.
  const [preview, setPreview] = useState<HeroFocus | null>(null);
  const shown = preview ?? focus;
  // While curating, a tile is something being arranged, not a link: clicking it (or its CTA) must
  // not navigate away from the unpublished draft.
  const open = () => {
    if (!curating) onOpen(item.id);
  };
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
      role={curating ? 'group' : 'link'}
      tabIndex={0}
      aria-label={title}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="hero-tile-media">
        {url && (
          <img
            ref={imgRef}
            className="hero-tile-img"
            src={url}
            alt=""
            draggable={false}
            style={{ objectPosition: objectPosition(shown) }}
            {...(priority ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
          />
        )}
        {curating && reframing && onFocusChange && (
          <ReframeOverlay
            imgRef={imgRef}
            focus={shown ?? { x: 50, y: 50 }}
            onPreview={setPreview}
            onCommit={(f) => {
              onFocusChange(item.id, f);
              setPreview(null);
            }}
            onDone={() => setReframing(false)}
          />
        )}
        {curating &&
          (rank ? (
            <span className="hero-slot-badge is-pinned">Pinned #{rank}</span>
          ) : (
            <span className="hero-slot-badge">Auto</span>
          ))}
        {curating && !reframing && (
          <div className="hero-tile-tools">
            {onFocusChange && url && (
              <button
                type="button"
                className="hero-tool-btn"
                title="Reposition image"
                aria-label="Reposition image"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setReframing(true);
                }}
              >
                <Move size={14} strokeWidth={2.25} aria-hidden />
              </button>
            )}
            {pinned && onUnpin && (
              <button
                type="button"
                className="hero-tool-btn hero-unpin"
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
        )}
      </div>
      <div className="hero-tile-body">
        <div className="hero-tile-badge">
          <SubjectTag subject={item.subject} />
          {main && !curating && <span className="hero-featured">FEATURED</span>}
        </div>
        <h3 className="hero-tile-title" title={title}>
          {title}
        </h3>
        {main && valueProp && <p className="hero-tile-valueprop">{valueProp}</p>}
        {item.author && <p className="hero-tile-author">{item.author}</p>}
        {main && (
          <button
            type="button"
            className="hero-tile-cta"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              open();
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
  focus?: HeroFocus;
  onOpen: (id: string) => void;
  onUnpin: (id: string) => void;
  onFocusChange?: (id: string, focus: HeroFocus | null) => void;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.item.id });
  return (
    <HeroTile {...props} curating sortable={{ setNodeRef, attributes, listeners, transform, transition, isDragging }} />
  );
};

const PlainHeroBoard = ({
  items,
  focus,
  onOpen,
  valueProp,
}: {
  items: ShowcaseCard[];
  focus: Record<string, HeroFocus>;
  onOpen: (id: string) => void;
  valueProp?: string;
}) => {
  const [main, ...rest] = items;
  return (
    <section className="hero-board" aria-label="Featured experiments">
      <HeroTile item={main} main priority valueProp={valueProp} focus={focus[main.id]} onOpen={onOpen} />
      {rest.slice(0, 4).map((item) => (
        <HeroTile key={item.id} item={item} focus={focus[item.id]} onOpen={onOpen} />
      ))}
    </section>
  );
};

/** Curate mode: the hero tiles become drag-sortable (dropping rewrites the whole visible order as
 *  pins — "what you arrange is what everyone sees"). Pinned tiles show their rank + an unpin button;
 *  algorithm-filled slots show "Auto". Every tile can have its thumbnail re-framed. */
const CuratableHeroBoard = ({
  items,
  heroIds,
  focus,
  onOpen,
  onReorder,
  onUnpin,
  onFocusChange,
}: {
  items: ShowcaseCard[];
  heroIds: string[];
  focus: Record<string, HeroFocus>;
  onOpen: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onUnpin: (id: string) => void;
  onFocusChange?: (id: string, focus: HeroFocus | null) => void;
}) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Pointer only (8px activation so a click on a tile button is never read as a drag); keyboard
  // reordering is in the tray.
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
              focus={focus[item.id]}
              onOpen={onOpen}
              onUnpin={onUnpin}
              onFocusChange={onFocusChange}
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
 * drag-sortable and gain pin/unpin and reposition-image affordances. `focus` is each thumbnail's
 * staff-chosen framing (object-position), shown to every visitor.
 */
const HeroBoard = ({
  items,
  onOpen,
  valueProp,
  curating,
  heroIds = [],
  focus = {},
  onReorder,
  onUnpin,
  onFocusChange,
}: {
  items: ShowcaseCard[];
  onOpen: (id: string) => void;
  valueProp?: string;
  curating?: boolean;
  heroIds?: string[];
  focus?: Record<string, HeroFocus>;
  onReorder?: (ids: string[]) => void;
  onUnpin?: (id: string) => void;
  onFocusChange?: (id: string, focus: HeroFocus | null) => void;
}) => {
  if (items.length === 0) return null;
  if (curating && onReorder && onUnpin) {
    return (
      <CuratableHeroBoard
        items={items}
        heroIds={heroIds}
        focus={focus}
        onOpen={onOpen}
        onReorder={onReorder}
        onUnpin={onUnpin}
        onFocusChange={onFocusChange}
      />
    );
  }
  return <PlainHeroBoard items={items} focus={focus} onOpen={onOpen} valueProp={valueProp} />;
};

export default HeroBoard;
