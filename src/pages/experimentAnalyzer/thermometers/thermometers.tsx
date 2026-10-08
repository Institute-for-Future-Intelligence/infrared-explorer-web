import { DragEvent } from 'react';
import Thermometer from './thermometer';

interface Props {
  thermometersId: string[];
  onUpdate: (id: string, x: number, y: number) => void;
  // Drop a new thermometer at the given [0,1] image coordinates (drag from the ToolBar add button).
  onAdd?: (x: number, y: number) => void;
  // Δ frame-difference mode: each probe shows Δ<name> and its (current − reference) reading (see Thermometer).
  showDiff?: boolean;
  refBuffer?: ArrayBuffer;
}

export const THERMOMETERS_WRAPPER_ID = 'thermometers-wrapper';
// dataTransfer marker so only the ToolBar "Add a thermometer" drag drops a thermometer.
export const DND_ADD_THERMOMETER = 'application/x-add-thermometer';

// Deselecting and the Delete key are shared with the lines and notes: see useFrameSelectionControls.
const Thermometers = ({ thermometersId, onUpdate, onAdd, showDiff, refBuffer }: Props) => {
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
        <Thermometer key={id} index={index} id={id} onUpdate={onUpdate} showDiff={showDiff} refBuffer={refBuffer} />
      ))}
    </div>
  );
};

export default Thermometers;
