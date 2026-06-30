import { DragEvent, MouseEvent, PointerEvent, useEffect } from 'react';
import Thermometer from './thermometer';
import useCommonStore from '../../../stores/common';
import { confirmDeleteThermometer } from './playerContextMenu';

/**
 * Clear the thermometer selection when the player background (not a thermometer or annotation) is
 * pressed. Bind this to the OUTER player wrapper, not #thermometers-wrapper: on mobile that inner
 * wrapper is `pointer-events: none` (so taps fall through to the native <video> play button), which
 * means its own onMouseDown never fires and selection could never be cleared by a tap. The outer
 * wrapper stays interactive, and a blank tap bubbles up to it from the video/image beneath the
 * overlays. Skips thermometers (`.draggable-div`) and annotation callouts (`#annotations-wrapper`)
 * so pressing those keeps / drives their own selection, matching the desktop behaviour.
 */
export const clearSelectionOnBackgroundPointerDown = (e: PointerEvent<HTMLDivElement>) => {
  const t = e.target as Element | null;
  if (t?.closest?.('.draggable-div') || t?.closest?.('#annotations-wrapper')) return;
  useCommonStore.getState().selectThermometer(null);
};

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

  // Clicking the empty image background (not a thermometer) clears the selection.
  const onBackgroundMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) useCommonStore.getState().selectThermometer(null);
  };

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
    <div id={THERMOMETERS_WRAPPER_ID} onMouseDown={onBackgroundMouseDown} onDragOver={onDragOver} onDrop={onDrop}>
      {thermometersId.map((id, index) => (
        <Thermometer key={id} index={index} id={id} onUpdate={onUpdate} />
      ))}
    </div>
  );
};

export default Thermometers;
