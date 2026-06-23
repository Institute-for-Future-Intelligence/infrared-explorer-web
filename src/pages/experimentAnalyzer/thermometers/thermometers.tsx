import { DragEvent, MouseEvent } from 'react';
import Thermometer from './thermometer';
import useCommonStore from '../../../stores/common';

interface Props {
  thermometersId: string[];
  onUpdate: (id: string, x: number, y: number) => void;
  // Drop a new thermometer at the given [0,1] image coordinates (drag from the ToolBar add button).
  onAdd?: (x: number, y: number) => void;
}

export const THERMOMETERS_WRAPPER_ID = 'thermometers-wrapper';
// dataTransfer marker so only the ToolBar "Add a thermometer" drag drops a thermometer.
export const DND_ADD_THERMOMETER = 'application/x-add-thermometer';

const Thermometers = ({ thermometersId, onUpdate, onAdd }: Props) => {
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
