import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { Modal, Form, Input, InputNumber, Row, Col } from 'antd';
import useCommonStore from '../../../stores/common';
import { firebaseDatabase } from '../../../services/firebase';
import { Annotation, Visibility } from '../../../types';
import { addAnnotation, deleteAnnotation, updateAnnotation } from '../../../services/experiments';

const WRAPPER_ID = 'annotations-wrapper';

// Imperative handle so the toolbar's "Add Annotation" button can open the add dialog (telelab parity).
export interface AnnotationsHandle {
  add: () => void;
}

interface Props {
  expId: string;
  ownerId?: string;
  visibility?: Visibility;
  // Accepted for compatibility; interactivity is now gated by ownership only (not by page).
  annotating?: boolean;
  // Reword toggle (annotate page): when on, a plain click on a callout opens its edit dialog.
  rewording?: boolean;
  // Current playback position / clip length in seconds (drives the time-window visibility).
  currentTime?: number;
  duration?: number;
}

// id === null means the dialog is creating a new annotation (telelab's "Add Annotation" flow).
type Draft = { id: string | null; note: string; start: number; end: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Telelab-style annotation overlay: each note is an SVG callout (anchor dot + connector line +
 * underlined text). Owners can drag the note or the anchor, nudge the selected one with the arrow
 * keys, right-click a callout for Edit / Delete, add via a dialog (text + time window) and reword
 * via that same dialog. Viewers (and the owner off the annotate page) see them read-only, filtered
 * by the time window.
 */
const Annotations = forwardRef<AnnotationsHandle, Props>(
  ({ expId, ownerId, visibility, rewording, currentTime = 0, duration = 0 }, ref) => {
    const user = useCommonStore((state) => state.user);
    const editable = !!user && user.id === ownerId;
    // The owner can select / drag / right-click annotations on ANY toolbar page (telelab parity) —
    // not just the annotate page. The annotate page only adds the Add / Reword toolbar buttons.
    const interactive = editable;

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

    useEffect(() => {
      let active = true;
      (async () => {
        try {
          // "Rules are not filters": filter the list to match the read rule (own docs, or public),
          // otherwise an unfiltered list on a per-doc-data rule is rejected with permission-denied.
          const coll = collection(firebaseDatabase, `experiments/${expId}/annotations`);
          const q =
            user && user.id === ownerId
              ? query(coll, where('ownerId', '==', user.id))
              : query(coll, where('visibility', 'in', [Visibility.Public, Visibility.Unlisted]));
          const snap = await getDocs(q);
          if (active) setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Annotation, 'id'>) })));
        } catch (e) {
          console.error('failed to load annotations', e);
        }
      })();
      return () => {
        active = false;
      };
    }, [expId, ownerId, user]);

    const patchLocal = (id: string, fields: Partial<Annotation>) =>
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)));

    // Persist a drag / keyboard nudge to Firestore (optimistic local update first).
    const persist = (id: string, fields: Partial<Annotation>) => {
      patchLocal(id, fields);
      updateAnnotation(expId, id, fields).catch((e) => console.error('failed to update annotation', e));
    };

    const remove = (id: string) => {
      setItems((prev) => prev.filter((a) => a.id !== id));
      if (selectedId === id) setSelectedId(null);
      deleteAnnotation(expId, id).catch((e) => console.error('failed to delete annotation', e));
    };

    const confirmDelete = (id: string) =>
      Modal.confirm({
        title: 'Delete this annotation?',
        okText: 'Delete',
        okButtonProps: { danger: true },
        onOk: () => remove(id),
      });

    // "Add Annotation" opens the dialog for a new note (id === null); it's created on OK.
    const onAdd = () => {
      if (!editable) return;
      setNoteError(false);
      setDraft({ id: null, note: '', start: 0, end: maxTime });
    };

    // Always invoke the latest onAdd (avoids a stale closure captured at mount).
    const onAddRef = useRef(onAdd);
    onAddRef.current = onAdd;
    useImperativeHandle(ref, () => ({ add: () => onAddRef.current() }), []);

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

      const onUp = (ev: PointerEvent) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
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
    };

    // Right-click a callout: open our Edit / Delete menu and suppress the image's thermometer menu.
    const openContextMenu = (e: React.MouseEvent, id: string) => {
      if (!interactive) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(id);
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
        if (!user) return;
        // New annotation: default anchor near the centre, note offset below-left so the connector shows.
        const drafted = { x: 0.5, y: 0.4, dx: -0.08, dy: 0.14, note, time: { start, end } };
        try {
          const id = await addAnnotation(expId, user, drafted, visibility);
          setItems((prev) => [...prev, { id, ...drafted }]);
          setSelectedId(id);
        } catch (err) {
          console.error('failed to add annotation', err);
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
                className="annotation-menu-item annotation-menu-item-danger"
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
          destroyOnClose
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

  return (
    <g>
      <line x1={ax} y1={ay} x2={nx} y2={ny} stroke={color} strokeWidth={1.5} style={{ pointerEvents: 'none' }} />
      <circle
        cx={ax}
        cy={ay}
        r={6}
        fill={color}
        style={{ pointerEvents: grab, cursor }}
        onPointerDown={onPointerDownAnchor}
        onContextMenu={onContextMenu}
      />
      <text
        x={nx}
        y={ny}
        dy={-6}
        fill={color}
        stroke="transparent"
        strokeWidth={14}
        paintOrder="stroke"
        fontSize={14}
        fontWeight="bold"
        textAnchor={anchorEnd ? 'end' : 'start'}
        style={{ pointerEvents: grab, cursor, textDecoration: 'underline', userSelect: 'none' }}
        onPointerDown={onPointerDownNote}
        onContextMenu={onContextMenu}
      >
        {note}
      </text>
    </g>
  );
};

export default Annotations;
