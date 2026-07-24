import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { Modal, Form, Input, InputNumber, Row, Col } from 'antd';
import useCommonStore from '../../../stores/common';
import { firebaseDatabase } from '../../../services/firebase';
import { Annotation, Visibility } from '../../../types';
import { addAnnotation, deleteAnnotation, updateAnnotation } from '../../../services/experiments';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { annotationRegistry, AnnotationInfo } from '../../../components/aiChat/annotationRegistry';

const WRAPPER_ID = 'annotations-wrapper';

// Imperative handle so the toolbar's "Add Annotation" button can open the add dialog (telelab parity)
// and the player's right-click menu can clear every annotation at once.
export interface AnnotationsHandle {
  // `pos` (a [0,1] anchor) drops the new note where the user right-clicked; omitted → centre default.
  add: (pos?: { x: number; y: number }) => void;
  deleteAll: () => void;
}

interface Props {
  expId: string;
  ownerId?: string;
  visibility?: Visibility;
  // Accepted for compatibility; interactivity is now gated by sign-in only (not by page).
  annotating?: boolean;
  // Reword toggle (annotate page): when on, a plain click on a callout opens its edit dialog.
  rewording?: boolean;
  // Current playback position / clip length in seconds (drives the time-window visibility).
  currentTime?: number;
  duration?: number;
  // Reports the count of deletable annotations (any, for a signed-in user) so the player can disable
  // "Delete all annotations" when there are none / a signed-out visitor can't edit them.
  onCountChange?: (count: number) => void;
  // Called when a callout takes over a pointer interaction (select/drag or right-click menu), so the
  // player can shut its own right-click menu — which rc-dropdown would otherwise leave open, since it
  // only auto-hides a contextMenu menu on a left click and the callout stops propagation.
  onCloseContextMenu?: () => void;
}

// id === null means the dialog is creating a new annotation (telelab's "Add Annotation" flow).
// x/y are the [0,1] anchor for a new note (from a right-click); absent → centre default on save.
type Draft = { id: string | null; note: string; start: number; end: number; x?: number; y?: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Telelab-style annotation overlay: each note is an SVG callout (anchor dot + connector line +
 * underlined text). Anyone (signed-out visitors included) can drag the note or the anchor, nudge the
 * selected one with the arrow keys, right-click a callout for Edit / Delete, add via a dialog (text +
 * time window) and reword via that same dialog. Those edits persist to the source only for the owner;
 * everyone else's are a local sandbox kept by cloning. Notes are filtered by the time window.
 */
const Annotations = forwardRef<AnnotationsHandle, Props>(
  (
    { expId, ownerId, visibility, rewording, currentTime = 0, duration = 0, onCountChange, onCloseContextMenu },
    ref,
  ) => {
    const user = useCommonStore((state) => state.user);
    // Anyone — including signed-out visitors — can manipulate annotations locally (the analyzer is a
    // sandbox, like the thermometers). Only the owner's edits persist to the source; everyone else
    // keeps their work by cloning. `isOwner` gates the writes to Firestore.
    const isOwner = !!user && user.id === ownerId;
    // Select / drag / right-click annotations on ANY toolbar page (telelab parity) — not just the
    // annotate page. The annotate page only adds the Add / Reword buttons.
    const interactive = true;

    // Whole-second video length, used as BOTH the default end time and the InputNumber max so the
    // default never exceeds max (a raw float would, making antd render the value red as out-of-range).
    const maxTime = Math.max(0, Math.round(duration));

    const [items, setItems] = useState<Annotation[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    // Only surface the empty-note error after a submit attempt, not while the dialog first opens.
    const [noteError, setNoteError] = useState(false);
    // Right-click context menu (Edit / Delete) anchored at the cursor.
    const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

    const svgRef = useRef<SVGSVGElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    // True once the initial Firestore load has populated `items`. The store mirror below waits on it
    // so the pre-load empty array is never mirrored — otherwise an immediate clone would save no notes.
    const loadedRef = useRef(false);

    useEffect(() => {
      let active = true;
      (async () => {
        try {
          // "Rules are not filters": filter the list to match the read rule (own docs, or public),
          // otherwise an unfiltered list on a per-doc-data rule is rejected with permission-denied.
          const coll = collection(firebaseDatabase, `experiments/${expId}/annotations`);
          const q = isOwner
            ? query(coll, where('ownerId', '==', ownerId))
            : query(coll, where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]));
          const snap = await getDocs(q);
          if (active) {
            loadedRef.current = true;
            setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Annotation, 'id'>) })));
          }
        } catch (e) {
          console.error('failed to load annotations', e);
        }
      })();
      return () => {
        active = false;
      };
      // Keyed on isOwner, NOT the whole user: a non-owner signing in (the common sandbox case — a
      // visitor playing with a showcase's annotations) must not re-run this fetch, or it would clobber
      // their unsaved local edits. Only an owner⇄non-owner transition changes which notes are visible
      // and warrants a reload. (Reading `user` directly would re-fetch on every sign-in and lose edits.)
    }, [expId, ownerId, isOwner]);

    // Mirror the live notes into the store so a clone ("Save to My Experiments" / "Save clip") can
    // include the viewer's local sandbox edits — these notes are component state and aren't otherwise
    // visible to the clone service. Only after the initial load (loadedRef) so a not-yet-loaded empty
    // list can't wipe the copy's notes; the clone falls back to copying the source when nothing is set.
    useEffect(() => {
      if (!loadedRef.current) return;
      useCommonStore.getState().setAnalyzerAnnotations(expId, items);
    }, [expId, items]);

    const patchLocal = (id: string, fields: Partial<Annotation>) =>
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)));

    // Apply a drag / keyboard nudge (optimistic local update first). Persisted to the source only for
    // the owner; a non-owner's change stays local until they clone the experiment.
    const persist = (id: string, fields: Partial<Annotation>) => {
      patchLocal(id, fields);
      if (isOwner) updateAnnotation(expId, id, fields).catch((e) => console.error('failed to update annotation', e));
    };

    const remove = (id: string) => {
      setItems((prev) => prev.filter((a) => a.id !== id));
      if (selectedId === id) setSelectedId(null);
      if (isOwner) deleteAnnotation(expId, id).catch((e) => console.error('failed to delete annotation', e));
    };

    const confirmDelete = (id: string) =>
      Modal.confirm({
        title: 'Delete this annotation?',
        okText: 'Delete',
        okButtonProps: { danger: true },
        onOk: () => remove(id),
      });

    // Clear all annotations at once (player's right-click "Delete all annotations"), asking first.
    const deleteAll = () => {
      if (items.length === 0) return;
      Modal.confirm({
        title: 'Delete all annotations?',
        okText: 'Delete',
        okButtonProps: { danger: true },
        onOk: () => {
          const ids = items.map((a) => a.id);
          setItems([]);
          setSelectedId(null);
          if (isOwner) {
            ids.forEach((id) =>
              deleteAnnotation(expId, id).catch((e) => console.error('failed to delete annotation', e)),
            );
          }
        },
      });
    };

    // Keep the player's "Delete all annotations" enablement in sync (anyone can clear them locally).
    useEffect(() => {
      onCountChange?.(items.length);
    }, [items, onCountChange]);

    // "Add Annotation" opens the dialog for a new note (id === null); it's created on OK. `pos`
    // (from a right-click) becomes the new note's anchor, so it lands where the user clicked.
    const onAdd = (pos?: { x: number; y: number }) => {
      setNoteError(false);
      setDraft({ id: null, note: '', start: 0, end: maxTime, x: pos?.x, y: pos?.y });
    };

    // Always invoke the latest handlers (avoids a stale closure captured at mount).
    const onAddRef = useRef(onAdd);
    onAddRef.current = onAdd;
    const deleteAllRef = useRef(deleteAll);
    deleteAllRef.current = deleteAll;
    useImperativeHandle(
      ref,
      () => ({ add: (pos) => onAddRef.current(pos), deleteAll: () => deleteAllRef.current() }),
      [],
    );

    // Programmatic add / edit / list / remove for the Lab Assistant (the global AI widget), reusing the
    // SAME owner→Firestore / non-owner→sandbox persistence as the dialog. Published via annotationRegistry
    // (like playerRegistry) and routed through a latest-ref so the once-registered controller always sees
    // the current items/handlers. Cleared on unmount.
    const agentAdd = async (a: { x: number; y: number; note: string; startSec?: number; endSec?: number }) => {
      const note = a.note.trim();
      if (!note) return null;
      const start = Math.max(0, a.startSec ?? 0);
      const end = Math.max(start, a.endSec ?? maxTime);
      const drafted = { x: clamp(a.x, 0, 1), y: clamp(a.y, 0, 1), dx: -0.08, dy: 0.14, note, time: { start, end } };
      if (isOwner && user) {
        try {
          const id = await addAnnotation(expId, user, drafted, visibility);
          setItems((prev) => [...prev, { id, ...drafted }]);
          setSelectedId(id);
          return id;
        } catch (e) {
          console.error('failed to add annotation', e);
          return null;
        }
      }
      const id = crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}-${Math.round(performance.now())}`;
      setItems((prev) => [...prev, { id, ...drafted }]);
      setSelectedId(id);
      return id;
    };
    const agentUpdate = (
      id: string,
      fields: { note?: string; x?: number; y?: number; startSec?: number; endSec?: number },
    ) => {
      const a = items.find((x) => x.id === id);
      if (!a) return false;
      const patch: Partial<Annotation> = {};
      if (fields.note != null) patch.note = fields.note.trim();
      if (fields.x != null) patch.x = clamp(fields.x, 0, 1);
      if (fields.y != null) patch.y = clamp(fields.y, 0, 1);
      if (fields.startSec != null || fields.endSec != null) {
        const start = Math.max(0, fields.startSec ?? a.time?.start ?? 0);
        const end = Math.max(start, fields.endSec ?? a.time?.end ?? maxTime);
        patch.time = { start, end };
      }
      persist(id, patch);
      return true;
    };
    const agentList = (): AnnotationInfo[] =>
      items.map((a) => ({
        id: a.id,
        note: a.note,
        x: Number(a.x.toFixed(3)),
        y: Number(a.y.toFixed(3)),
        time: a.time ?? null,
      }));
    const agentOpsRef = useRef({ add: agentAdd, update: agentUpdate, remove, list: agentList });
    agentOpsRef.current = { add: agentAdd, update: agentUpdate, remove, list: agentList };
    useEffect(() => {
      const controller = {
        add: (a: { x: number; y: number; note: string; startSec?: number; endSec?: number }) =>
          agentOpsRef.current.add(a),
        update: (id: string, f: { note?: string; x?: number; y?: number; startSec?: number; endSec?: number }) =>
          agentOpsRef.current.update(id, f),
        remove: (id: string) => agentOpsRef.current.remove(id),
        list: () => agentOpsRef.current.list(),
      };
      annotationRegistry.controller = controller;
      return () => {
        if (annotationRegistry.controller === controller) annotationRegistry.controller = null;
      };
    }, []);

    // Clicking empty space clears the selection — but never when the press lands on a callout
    // (checked by target, so it's robust regardless of event-propagation timing).
    useEffect(() => {
      if (!interactive) return;
      const onDocDown = (e: PointerEvent) => {
        const t = e.target as Element | null;
        if (t?.closest?.(`#${WRAPPER_ID}`)) return;
        setSelectedId(null);
      };
      document.addEventListener('pointerdown', onDocDown);
      return () => document.removeEventListener('pointerdown', onDocDown);
    }, [interactive]);

    // Close the context menu on any click outside it.
    useEffect(() => {
      if (!menu) return;
      const onDown = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
      };
      const timer = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('mousedown', onDown);
      };
    }, [menu]);

    // Keyboard: nudge the selected callout with the arrows, delete it with Delete/Backspace.
    useEffect(() => {
      if (!interactive || !selectedId || draft) return;
      const onKey = (e: KeyboardEvent) => {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        const sel = items.find((a) => a.id === selectedId);
        if (!sel) return;
        const step = 0.01;
        if (e.key === 'ArrowUp') persist(selectedId, { y: Math.max(0, sel.y - step) });
        else if (e.key === 'ArrowDown') persist(selectedId, { y: Math.min(1, sel.y + step) });
        else if (e.key === 'ArrowLeft') persist(selectedId, { x: Math.max(0, sel.x - step) });
        else if (e.key === 'ArrowRight') persist(selectedId, { x: Math.min(1, sel.x + step) });
        else if (e.key === 'Delete' || e.key === 'Backspace') confirmDelete(selectedId);
        else return;
        e.preventDefault();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [interactive, selectedId, draft, items]);

    // Drag a callout part. `mode` = 'note' moves the offset (dx,dy); 'anchor' moves the point (x,y).
    const startDrag = (e: React.PointerEvent, a: Annotation, mode: 'note' | 'anchor') => {
      if (!interactive) return;
      if (e.button === 2) return; // ignore right-click so the context menu can open
      e.stopPropagation(); // keep the selection (the document handler would otherwise clear it)
      e.preventDefault();
      setSelectedId(a.id);
      // One selection at a time → one Delete target. This drag stops propagation, so the thermometer /
      // profile-line document deselect listeners won't fire on their own — clear both here.
      useCommonStore.getState().selectThermometer(null);
      useCommonStore.getState().selectProfileLine(null);
      onCloseContextMenu?.(); // we stopped propagation, so dismiss any open player menu ourselves
      const svg = svgRef.current;
      if (!svg) return;
      let moved = false;

      const toFrac = (clientX: number, clientY: number) => {
        const rect = svg.getBoundingClientRect();
        return {
          fx: clamp((clientX - rect.left) / rect.width, 0, 1),
          fy: clamp((clientY - rect.top) / rect.height, 0, 1),
        };
      };

      const onMove = (ev: PointerEvent) => {
        moved = true;
        const { fx, fy } = toFrac(ev.clientX, ev.clientY);
        if (mode === 'note') patchLocal(a.id, { dx: clamp(fx - a.x, -1, 1), dy: clamp(fy - a.y, -1, 1) });
        else patchLocal(a.id, { x: fx, y: fy });
      };

      // On touch, touch-action:none on an SVG sub-element is unreliable (iOS Safari ignores it), so the
      // browser claims the drag for scrolling and pointermove stops firing (→ pointercancel). A native
      // non-passive touchmove listener that preventDefaults is what actually stops the page scrolling,
      // matching the thermometer resize handles. (preventDefault on the React pointerdown can't: that
      // listener is passive.)
      const onTouchMove = (ev: TouchEvent) => ev.preventDefault();

      const cleanup = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.removeEventListener('touchmove', onTouchMove);
      };

      const onUp = (ev: PointerEvent) => {
        cleanup();
        if (!moved) {
          // A click (no drag): in reword mode open the editor, otherwise just select.
          if (rewording) openEditor(a.id);
          return;
        }
        const { fx, fy } = toFrac(ev.clientX, ev.clientY);
        if (mode === 'note') persist(a.id, { dx: clamp(fx - a.x, -1, 1), dy: clamp(fy - a.y, -1, 1) });
        else persist(a.id, { x: fx, y: fy });
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp); // a stolen gesture would otherwise leak listeners
      document.addEventListener('touchmove', onTouchMove, { passive: false });
    };

    // Right-click a callout: open our Edit / Delete menu and suppress the image's thermometer menu.
    const openContextMenu = (e: React.MouseEvent, id: string) => {
      if (!interactive) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(id);
      // One selection at a time → one Delete target. This drag stops propagation, so the thermometer /
      // profile-line document deselect listeners won't fire on their own — clear both here.
      useCommonStore.getState().selectThermometer(null);
      useCommonStore.getState().selectProfileLine(null);
      onCloseContextMenu?.(); // close the player's right-click menu (rc-dropdown won't, on a right-click)
      setMenu({ id, x: e.clientX, y: e.clientY });
    };

    const openEditor = (id: string) => {
      const a = items.find((x) => x.id === id);
      if (!a) return;
      setNoteError(false);
      setDraft({ id, note: a.note, start: a.time?.start ?? 0, end: a.time?.end ?? maxTime });
    };

    const saveDraft = async () => {
      if (!draft) return;
      const note = draft.note.trim();
      const start = Math.max(0, draft.start);
      const end = draft.end;
      // Guard the OK / Enter paths: an empty note reveals the error (shown only on submit), and an
      // invalid time window is blocked too.
      if (!note) {
        setNoteError(true);
        return;
      }
      if (end < start) return;
      if (draft.id === null) {
        // New annotation: anchor where the user right-clicked (draft.x/y) or near the centre by
        // default; note offset below-left so the connector shows.
        const drafted = { x: draft.x ?? 0.5, y: draft.y ?? 0.4, dx: -0.08, dy: 0.14, note, time: { start, end } };
        if (isOwner && user) {
          try {
            const id = await addAnnotation(expId, user, drafted, visibility);
            setItems((prev) => [...prev, { id, ...drafted }]);
            setSelectedId(id);
          } catch (err) {
            console.error('failed to add annotation', err);
          }
        } else {
          // Non-owner (or signed-out): add locally only — a sandbox edit, not written to the source.
          const id = crypto.randomUUID ? crypto.randomUUID() : `a-${Date.now()}-${Math.round(performance.now())}`;
          setItems((prev) => [...prev, { id, ...drafted }]);
          setSelectedId(id);
        }
      } else {
        persist(draft.id, { note, time: { start, end } });
      }
      setDraft(null);
    };

    const visible = (a: Annotation) => !a.time || (currentTime >= a.time.start && currentTime <= a.time.end);

    return (
      <div id={WRAPPER_ID} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <svg ref={svgRef} width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          {items.filter(visible).map((a) => (
            <Callout
              key={a.id}
              data={a}
              color={selectedId === a.id ? 'yellow' : 'white'}
              interactive={interactive}
              onPointerDownNote={(e) => startDrag(e, a, 'note')}
              onPointerDownAnchor={(e) => startDrag(e, a, 'anchor')}
              onContextMenu={(e) => openContextMenu(e, a.id)}
            />
          ))}
        </svg>

        {menu &&
          createPortal(
            <div
              ref={menuRef}
              className="annotation-menu"
              style={{
                position: 'fixed',
                left: Math.min(menu.x, window.innerWidth - 140),
                top: Math.min(menu.y, window.innerHeight - 80),
              }}
            >
              <div
                className="annotation-menu-item"
                onClick={() => {
                  openEditor(menu.id);
                  setMenu(null);
                }}
              >
                Edit
              </div>
              <div
                className="annotation-menu-item"
                onClick={() => {
                  confirmDelete(menu.id);
                  setMenu(null);
                }}
              >
                Delete
              </div>
            </div>,
            document.body,
          )}

        <Modal
          title={draft?.id ? 'Edit Annotation' : 'Add Annotation'}
          open={!!draft}
          onOk={saveDraft}
          onCancel={() => {
            setDraft(null);
            setNoteError(false);
          }}
          okText="OK"
          okButtonProps={{ disabled: !draft || draft.end < draft.start }}
          destroyOnHidden
        >
          {draft && (
            <Form layout="vertical">
              <Form.Item
                label="Note"
                required
                validateStatus={noteError && !draft.note.trim() ? 'error' : ''}
                help={noteError && !draft.note.trim() ? 'Note cannot be empty' : undefined}
              >
                <Input
                  autoFocus
                  value={draft.note}
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  onPressEnter={saveDraft}
                  placeholder="Annotation text"
                />
              </Form.Item>
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="Start time (s)">
                    <InputNumber
                      min={0}
                      max={maxTime || undefined}
                      value={draft.start}
                      onChange={(v) => setDraft({ ...draft, start: v ?? 0 })}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item
                    label="End time (s)"
                    validateStatus={draft.end < draft.start ? 'error' : ''}
                    help={draft.end < draft.start ? 'End must be ≥ start' : undefined}
                  >
                    <InputNumber
                      min={0}
                      max={maxTime || undefined}
                      value={draft.end}
                      onChange={(v) => setDraft({ ...draft, end: v ?? 0 })}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          )}
        </Modal>
      </div>
    );
  },
);
Annotations.displayName = 'Annotations';

interface CalloutProps {
  data: Annotation;
  color: string;
  interactive: boolean;
  onPointerDownNote: (e: React.PointerEvent) => void;
  onPointerDownAnchor: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

/**
 * One annotation rendered as an SVG callout: anchor dot + connector line + underlined note text.
 * Positioned with percentages so the browser resolves coordinates against the live overlay size
 * (no JS measuring — robust across loads/resizes). The click handlers live directly on the painted
 * text and dot (pointer-events: auto, which reliably overrides the wrapper's pointer-events: none).
 * A fat transparent stroke around the text widens its grab area without changing its look.
 */
const Callout = ({ data, color, interactive, onPointerDownNote, onPointerDownAnchor, onContextMenu }: CalloutProps) => {
  const { x, y, note } = data;
  // A finger needs a far bigger grab area than a cursor: widen the anchor dot's and the note text's
  // transparent hit zone on touch so they're easy to drag and long-press (matches the bigger
  // thermometer resize handles on mobile). The painted dot / text are unchanged; only the invisible
  // stroke that catches the pointer grows.
  const isMobile = useIsMobile();
  // Legacy notes (created before offsets existed) have no dx/dy — give them a visible offset so the
  // connector + anchor still read as a callout. An explicit 0 (note dragged onto the dot) is kept.
  const dx = data.dx ?? -0.06;
  const dy = data.dy ?? 0.1;
  const ax = `${x * 100}%`;
  const ay = `${y * 100}%`;
  const nx = `${(x + dx) * 100}%`;
  const ny = `${(y + dy) * 100}%`;
  const cursor = interactive ? 'move' : 'default';
  const grab = interactive ? 'auto' : 'none';
  const anchorEnd = dx < 0;
  const anchorHitStroke = isMobile ? 28 : 0; // transparent ring widening the dot's tap target
  const noteHitStroke = isMobile ? 28 : 14;

  return (
    <g>
      <line x1={ax} y1={ay} x2={nx} y2={ny} stroke={color} strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
      <circle
        cx={ax}
        cy={ay}
        r={6}
        fill={color}
        // A transparent stroke widens the hittable area without changing the painted dot (same trick
        // the note text uses below). Bigger on touch so a fingertip lands on it reliably.
        stroke="transparent"
        strokeWidth={anchorHitStroke}
        paintOrder="stroke"
        // touchAction: 'none' so a touch-drag moves the dot instead of scrolling the page (otherwise
        // the browser claims the gesture and pointermove stops firing → the anchor won't move on mobile).
        style={{ pointerEvents: grab, cursor, touchAction: 'none' }}
        onPointerDown={onPointerDownAnchor}
        onContextMenu={onContextMenu}
      />
      <text
        x={nx}
        y={ny}
        dy={-6}
        fill={color}
        stroke="transparent"
        strokeWidth={noteHitStroke}
        paintOrder="stroke"
        fontSize={14}
        fontWeight="bold"
        textAnchor={anchorEnd ? 'end' : 'start'}
        // touchAction: 'none' so a touch-drag moves the note instead of scrolling the page on mobile.
        style={{ pointerEvents: grab, cursor, textDecoration: 'underline', userSelect: 'none', touchAction: 'none' }}
        onPointerDown={onPointerDownNote}
        onContextMenu={onContextMenu}
      >
        {note}
      </text>
    </g>
  );
};

export default Annotations;
