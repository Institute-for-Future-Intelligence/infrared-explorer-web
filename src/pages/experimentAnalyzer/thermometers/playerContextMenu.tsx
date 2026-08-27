import type { MenuProps } from 'antd';
import { Input, Modal } from 'antd';
import { MeasuringAreaType, ProfileLine, Thermometer } from '../../../types';
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

// Same confirm flow for the T(l) profile lines (used by the menu AND the overlay's Delete shortcut).
export const confirmDeleteProfileLine = (expId: string, id: string) =>
  confirmDelete('Delete this line?', () => useCommonStore.getState().removeProfileLine(expId, id));

export const confirmDeleteAllProfileLines = (expId: string) =>
  confirmDelete('Delete all lines?', () => useCommonStore.getState().removeAllProfileLines(expId));

// Prompt for a new line name (prefilled). Empty clears it back to the positional default ("L1", "L2", …).
const promptRenameProfileLine = (current: string, onOk: (name: string) => void) => {
  let value = current;
  const submit = () => onOk(value.trim());
  const modal = Modal.confirm({
    title: 'Rename line',
    icon: null,
    okText: 'Rename',
    content: (
      <Input
        autoFocus
        defaultValue={current}
        maxLength={40}
        placeholder="Line name"
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
  // The selected T(l) line (right-clicked), and all lines — for the rename label + "delete all" gate.
  selectedProfileLine?: ProfileLine;
  profileLines?: ProfileLine[];
  onAddProfileLine?: () => void;
  // Whether to offer the "Add annotation" entry (the analyzer is a local sandbox, so always on).
  canAddAnnotation: boolean;
  onAdd: () => void;
  onAddAnnotation: () => void;
  onPickMeasuringArea: (type: MeasuringAreaType) => void;
  onDeleteAllAnnotations: () => void;
  // Δ frame-difference overlay: when it's on, offer "Set current frame as reference" so the user can pick
  // what the difference is measured against (default is frame 0). Absent → the entry isn't shown.
  onSetDiffReference?: () => void;
  // "Ask about this moment" (AI Q&A): attaches the current playhead as a moment to the Q&A panel's next
  // question (owner-staff gated); the moment is a frozen frame snapshot (capped at 3).
  canAskMoment?: boolean;
  onAskMoment?: () => void;
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
  selectedProfileLine,
  profileLines,
  onAddProfileLine,
  canAddAnnotation,
  onAdd,
  onAddAnnotation,
  onPickMeasuringArea,
  onDeleteAllAnnotations,
  onSetDiffReference,
  canAskMoment,
  onAskMoment,
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
  // A selected T(l) line: rename it or delete it (parity with the thermometer menu).
  if (selectedProfileLine) {
    const index = (profileLines ?? []).findIndex((l) => l.id === selectedProfileLine.id);
    const currentLabel = selectedProfileLine.name?.trim() || `L${index + 1}`;
    return [
      {
        key: 'renameLine',
        label: 'Rename',
        onClick: () =>
          promptRenameProfileLine(currentLabel, (name) =>
            useCommonStore.getState().renameProfileLine(expId, selectedProfileLine.id, name || undefined),
          ),
      },
      {
        key: 'deleteLine',
        label: 'Delete',
        onClick: () => confirmDeleteProfileLine(expId, selectedProfileLine.id),
      },
    ];
  }
  // Over the empty image: add a thermometer (and an annotation), plus a "delete all" entry for each
  // kind only when there is actually something to delete (hidden, not greyed out).
  const items: NonNullable<MenuProps['items']> = [{ key: 'add', label: 'Add a thermometer', onClick: onAdd }];
  if (canAskMoment && onAskMoment) {
    // Offered for every Q&A model — a text-only one can't see the frame, but the moment still carries its
    // readings + frame stats (the Q&A panel's banner explains the difference).
    items.unshift({ key: 'askMoment', label: '❓ Ask about this moment', onClick: onAskMoment });
  }
  if (onAddProfileLine) {
    items.push({ key: 'addLine', label: 'Add a line', onClick: onAddProfileLine });
  }
  if (onSetDiffReference) {
    items.push({ key: 'setDiffRef', label: 'Set current frame as Δ reference', onClick: onSetDiffReference });
  }
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
  if ((profileLines?.length ?? 0) > 0) {
    items.push({
      key: 'deleteAllLines',
      label: 'Delete all lines',
      onClick: () => confirmDeleteAllProfileLines(expId),
    });
  }
  if (annotationCount > 0) {
    items.push({ key: 'deleteAllAnnotations', label: 'Delete all annotations', onClick: onDeleteAllAnnotations });
  }
  return items;
};
