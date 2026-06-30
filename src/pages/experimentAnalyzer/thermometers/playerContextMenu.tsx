import type { MenuProps } from 'antd';
import { Input, Modal } from 'antd';
import { MeasuringAreaType, Thermometer } from '../../../types';
import useCommonStore from '../../../stores/common';
import { measuringAreaSubmenuItem } from './measuringAreaMenu';

// Shared "Delete?" confirm (red OK) for every destructive thermometer action — the player menu and
// the keyboard-delete shortcut both go through these so deleting always asks first.
const confirmDelete = (title: string, onOk: () => void) =>
  Modal.confirm({ title, okText: 'Delete', okButtonProps: { danger: true }, onOk });

export const confirmDeleteThermometer = (expId: string, id: string) =>
  confirmDelete('Delete this thermometer?', () => useCommonStore.getState().removeThermometer(expId, id));

export const confirmDeleteAllThermometers = (expId: string) =>
  confirmDelete('Delete all thermometers?', () => useCommonStore.getState().removeAllThermometers(expId));

// Prompt for a new thermometer name (prefilled with the current label). `onOk` receives the trimmed
// value — empty means "clear the name" so it falls back to the positional default ("T1", "T2", …).
// Enter submits; the modal is captured so a keyboard submit can dismiss it just like clicking OK.
const promptRenameThermometer = (current: string, onOk: (name: string) => void) => {
  let value = current;
  const submit = () => onOk(value.trim());
  const modal = Modal.confirm({
    title: 'Rename thermometer',
    icon: null,
    okText: 'Rename',
    content: (
      <Input
        autoFocus
        defaultValue={current}
        maxLength={40}
        placeholder="Thermometer name"
        onChange={(e) => {
          value = e.target.value;
        }}
        onPressEnter={() => {
          submit();
          modal.destroy();
        }}
      />
    ),
    onOk: submit,
  });
};

// Equality fn for the player's menu-target subscription: re-render only when a field the menu/onPick
// actually use changes. The thermometer's `value` is rewritten every frame during playback; ignoring
// it keeps that churn from re-rendering the whole player while a menu target is held.
export const sameMenuTarget = (a: Thermometer | undefined, b: Thermometer | undefined) =>
  a?.id === b?.id &&
  a?.name === b?.name &&
  a?.measuringAreaType === b?.measuringAreaType &&
  a?.x === b?.x &&
  a?.y === b?.y &&
  a?.measuringAreaWidth === b?.measuringAreaWidth &&
  a?.measuringAreaHeight === b?.measuringAreaHeight;

/**
 * Convert a right-click's clientX/clientY to a [0,1] fraction within the overlay element `elementId`,
 * so a new thermometer / annotation lands where the user clicked instead of at the centre. Returns
 * null when the element is missing or not laid out yet (caller then falls back to the centre).
 */
export const clickFraction = (elementId: string, clientX: number, clientY: number) => {
  const el = document.getElementById(elementId);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  };
};

interface MenuArgs {
  expId: string;
  selectedThermometer: Thermometer | undefined;
  thermometersId: string[];
  annotationCount: number;
  // Whether to offer the "Add annotation" entry (the analyzer is a local sandbox, so always on).
  canAddAnnotation: boolean;
  onAdd: () => void;
  onAddAnnotation: () => void;
  onPickMeasuringArea: (type: MeasuringAreaType) => void;
  onDeleteAllAnnotations: () => void;
}

/**
 * The player's right-click menu. With a thermometer selected it's a focused menu for that one
 * (Measuring Area + delete it); over the empty image it's the background menu (add a thermometer /
 * delete all thermometers / delete all annotations). Every delete asks for confirmation first.
 */
export const buildPlayerContextMenu = ({
  expId,
  selectedThermometer,
  thermometersId,
  annotationCount,
  canAddAnnotation,
  onAdd,
  onAddAnnotation,
  onPickMeasuringArea,
  onDeleteAllAnnotations,
}: MenuArgs): MenuProps['items'] => {
  if (selectedThermometer) {
    // Prefill the rename box with the current label: the user-given name, or the positional default.
    const index = thermometersId.indexOf(selectedThermometer.id);
    const currentLabel = selectedThermometer.name?.trim() || `T${index + 1}`;
    return [
      {
        key: 'rename',
        label: 'Rename',
        onClick: () =>
          promptRenameThermometer(currentLabel, (name) =>
            // Empty clears the name (back to the positional default); the chart label follows via `name`.
            useCommonStore.getState().updateThermometer(selectedThermometer.id, { name: name || undefined }),
          ),
      },
      measuringAreaSubmenuItem(selectedThermometer, onPickMeasuringArea)!,
      {
        key: 'delete',
        label: 'Delete',
        onClick: () => confirmDeleteThermometer(expId, selectedThermometer.id),
      },
    ];
  }
  // Over the empty image: add a thermometer (and an annotation), plus a "delete all" entry for each
  // kind only when there is actually something to delete (hidden, not greyed out).
  const items: NonNullable<MenuProps['items']> = [{ key: 'add', label: 'Add a thermometer', onClick: onAdd }];
  if (canAddAnnotation) {
    items.push({ key: 'addAnnotation', label: 'Add annotation', onClick: onAddAnnotation });
  }
  if (thermometersId.length > 0) {
    items.push({
      key: 'deleteAll',
      label: 'Delete all thermometers',
      onClick: () => confirmDeleteAllThermometers(expId),
    });
  }
  if (annotationCount > 0) {
    items.push({ key: 'deleteAllAnnotations', label: 'Delete all annotations', onClick: onDeleteAllAnnotations });
  }
  return items;
};
