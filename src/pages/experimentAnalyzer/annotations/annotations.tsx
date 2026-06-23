import React, { useEffect, useRef, useState } from 'react';
import Draggable, { ControlPosition, DraggableData, DraggableEvent, DraggableProps } from 'react-draggable';
import { collection, getDocs, query, where } from 'firebase/firestore';
import useCommonStore from '../../../stores/common';
import { firebaseDatabase } from '../../../services/firebase';
import { Annotation, Visibility } from '../../../types';
import { addAnnotation, deleteAnnotation, updateAnnotation } from '../../../services/experiments';

// react-draggable's class-component props are flagged required under the resolved @types/react.
const DraggableBox = Draggable as unknown as React.ComponentType<Partial<DraggableProps>>;

const WRAPPER_ID = 'annotations-wrapper';

interface Props {
  expId: string;
  ownerId?: string;
  visibility?: Visibility;
}

/** Owner-editable text notes overlaid on the thermal image (viewers see them read-only). */
const Annotations = ({ expId, ownerId, visibility }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === ownerId;
  const [items, setItems] = useState<Annotation[]>([]);

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

  const onAdd = async () => {
    if (!editable || !user) return;
    const draft = { x: 0.45, y: 0.45, note: 'New note' };
    try {
      const id = await addAnnotation(expId, user, draft, visibility);
      setItems((prev) => [...prev, { id, ...draft }]);
    } catch (e) {
      console.error('failed to add annotation', e);
    }
  };

  const onMove = (id: string, x: number, y: number) => {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, x, y } : a)));
    updateAnnotation(expId, id, { x, y }).catch((e) => console.error('failed to move annotation', e));
  };

  const onEdit = (id: string, note: string) => {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, note } : a)));
    updateAnnotation(expId, id, { note }).catch((e) => console.error('failed to edit annotation', e));
  };

  const onRemove = (id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id));
    deleteAnnotation(expId, id).catch((e) => console.error('failed to delete annotation', e));
  };

  return (
    <div id={WRAPPER_ID} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {items.map((a) => (
        <AnnotationItem
          key={a.id}
          annotation={a}
          editable={editable}
          onMove={onMove}
          onEdit={onEdit}
          onRemove={onRemove}
        />
      ))}
      {editable && (
        <button
          onClick={onAdd}
          title="Add a note"
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            pointerEvents: 'auto',
            cursor: 'pointer',
            fontSize: 12,
            padding: '2px 8px',
            borderRadius: 4,
            border: 'none',
            background: 'rgba(0,0,0,0.55)',
            color: 'white',
          }}
        >
          + Note
        </button>
      )}
    </div>
  );
};

interface ItemProps {
  annotation: Annotation;
  editable: boolean;
  onMove: (id: string, x: number, y: number) => void;
  onEdit: (id: string, note: string) => void;
  onRemove: (id: string) => void;
}

const boxStyle: React.CSSProperties = {
  position: 'absolute',
  pointerEvents: 'auto',
  maxWidth: 180,
  background: 'rgba(0,0,0,0.6)',
  color: 'white',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 12,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 4,
};

const AnnotationItem = ({ annotation, editable, onMove, onEdit, onRemove }: ItemProps) => {
  const { id, x, y, note } = annotation;
  const nodeRef = useRef(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<ControlPosition | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      wrapperRef.current = document.getElementById(WRAPPER_ID);
      if (wrapperRef.current) {
        setPosition({ x: x * wrapperRef.current.clientWidth, y: y * wrapperRef.current.clientHeight });
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!position) return null;

  const onDragStop = (_e: DraggableEvent, data: DraggableData) => {
    if (wrapperRef.current) {
      onMove(id, data.x / wrapperRef.current.clientWidth, data.y / wrapperRef.current.clientHeight);
    }
  };

  const content = (
    <>
      {editing ? (
        <input
          className="annotation-no-drag"
          autoFocus
          defaultValue={note}
          onBlur={(e) => {
            onEdit(id, e.target.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onEdit(id, (e.target as HTMLInputElement).value);
              setEditing(false);
            }
          }}
          style={{ fontSize: 12, width: 130 }}
        />
      ) : (
        <span
          onDoubleClick={() => editable && setEditing(true)}
          style={{ whiteSpace: 'pre-wrap', cursor: editable ? 'text' : 'default' }}
        >
          {note}
        </span>
      )}
      {editable && !editing && (
        <span
          className="annotation-no-drag"
          title="Delete note"
          onClick={() => onRemove(id)}
          style={{ cursor: 'pointer', color: '#ff9a9a' }}
        >
          ×
        </span>
      )}
    </>
  );

  if (!editable) {
    return <div style={{ ...boxStyle, left: position.x, top: position.y, pointerEvents: 'none' }}>{content}</div>;
  }

  return (
    <DraggableBox
      nodeRef={nodeRef}
      defaultPosition={position}
      bounds="parent"
      cancel=".annotation-no-drag"
      onStop={onDragStop}
    >
      <div ref={nodeRef} style={boxStyle}>
        {content}
      </div>
    </DraggableBox>
  );
};

export default Annotations;
