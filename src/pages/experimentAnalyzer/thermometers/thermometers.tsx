import { DragEvent, useEffect } from 'react';
import Thermometer from './thermometer';
import useCommonStore from '../../../stores/common';
import { confirmDeleteThermometer } from './playerContextMenu';

interface Props {
  expId: string;
  thermometersId: string[];
  onUpdate: (id: string, x: number, y: number) => void;
  // Drop a new thermometer at the given [0,1] image coordinates (drag from the ToolBar add button).
  onAdd?: (x: number, y: number) => void;
}

export const THERMOMETERS_WRAPPER_ID = 'thermometers-wrapper';
// dataTransfer marker so only the ToolBar "Add a thermometer" drag drops a thermometer.
export const DND_ADD_THERMOMETER = 'application/x-add-thermometer';

const Thermometers = ({ expId, thermometersId, onUpdate, onAdd }: Props) => {
  // Delete / Backspace removes the selected thermometer (parity with the annotation shortcut), asking
  // for confirmation first. Ignored while typing in an input so it never eats a real keypress.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const selectedId = useCommonStore.getState().selectedThermometerId;
      if (!selectedId) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        confirmDeleteThermometer(expId, selectedId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expId]);

  // Clear the thermometer selection on any press that isn't a thermometer (`.draggable-div`), an
  // annotation callout (`#annotations-wrapper`, which drives its own selection), or the player's
  // right-click menu (`.ant-dropdown-menu` — so picking a Measuring Area doesn't deselect the
  // thermometer and hide its resize handles). A document listener, rather than a handler on the
  // player wrapper, is what lets a press OUTSIDE the player — the info panel, the sidebar — clear it
  // too (matching the annotation overlay); it also works on mobile, where the inner
  // #thermometers-wrapper is `pointer-events: none`.
  useEffect(() => {
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.draggable-div') || t?.closest?.('#annotations-wrapper') || t?.closest?.('.ant-dropdown-menu'))
        return;
      useCommonStore.getState().selectThermometer(null);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, []);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (onAdd && e.dataTransfer.types.includes(DND_ADD_THERMOMETER)) e.preventDefault();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!onAdd || !e.dataTransfer.types.includes(DND_ADD_THERMOMETER)) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onAdd(x, y);
  };

  return (
    <div id={THERMOMETERS_WRAPPER_ID} onDragOver={onDragOver} onDrop={onDrop}>
      {thermometersId.map((id, index) => (
        <Thermometer key={id} index={index} id={id} onUpdate={onUpdate} />
      ))}
    </div>
  );
};

export default Thermometers;
