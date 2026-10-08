import { useEffect, useRef } from 'react';
import useCommonStore, { FrameSelection, frameSelectionSize } from '../../stores/common';
import { confirmDelete } from './thermometers/playerContextMenu';

// Presses that leave the frame selection as it is: on a selectable item (a thermometer, a T(l) line's
// hit shapes, an annotation callout — the annotation wrapper itself never takes a press), or in the menus
// and dialogs that act on the selection (the player's right-click menu, the annotation menu, a confirm).
const KEEPS_SELECTION =
  '.draggable-div, .profile-line-hit, #annotations-wrapper, .ant-dropdown-menu, .annotation-menu, .ant-modal-root';

// On a Mac, Ctrl-click is a right-click (it opens the menu), so there only Shift and ⌘ select several.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

// Shift, Ctrl or ⌘ held on a click adds the item to the selection (or takes it out of it) instead of
// selecting just that item.
export const isToggleClick = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
  e.shiftKey || e.metaKey || (e.ctrlKey && !IS_MAC);

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// What a multi-item delete takes, for its confirm: "2 thermometers, 1 line and 1 annotation".
const describeSelection = (sel: FrameSelection) => {
  const parts: string[] = [];
  if (sel.thermometers.length) parts.push(counted(sel.thermometers.length, 'thermometer'));
  if (sel.profileLines.length) parts.push(counted(sel.profileLines.length, 'line'));
  if (sel.annotations.length) parts.push(counted(sel.annotations.length, 'annotation'));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
};

/**
 * Ask, then delete everything in `sel` together. Thermometers and lines go in one store write; the notes
 * are <Annotations>' state, so `removeAnnotations` hands them to it. Both land inside the undo recorder's
 * coalescing window, so Ctrl+Z brings the whole lot back at once. `sel` is a snapshot taken before the
 * confirm opens — the press on its button would clear the live selection.
 */
export const confirmDeleteFrameItems = (
  expId: string,
  sel: FrameSelection,
  removeAnnotations: (ids: string[]) => void,
) => {
  const count = frameSelectionSize(sel);
  if (count === 0) return;
  const title =
    count > 1
      ? `Delete ${count} selected items?`
      : sel.thermometers.length
        ? 'Delete this thermometer?'
        : sel.profileLines.length
          ? 'Delete this line?'
          : 'Delete this annotation?';
  confirmDelete(
    title,
    () => {
      useCommonStore.getState().removeFrameItems(expId, sel);
      if (sel.annotations.length) removeAnnotations(sel.annotations);
    },
    count > 1 ? describeSelection(sel) : undefined,
  );
};

/**
 * The frame selection's page-wide keys and clicks, mounted once by each player: a press anywhere that
 * isn't on a selectable item (or in a menu / dialog acting on the selection) clears it, and Delete /
 * Backspace deletes everything selected, asking first. `removeAnnotations` removes notes from
 * <Annotations>, which owns them.
 */
export function useFrameSelectionControls(expId: string, removeAnnotations: (ids: string[]) => void): void {
  const removeRef = useRef(removeAnnotations);
  removeRef.current = removeAnnotations;

  useEffect(() => {
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(KEEPS_SELECTION)) return;
      useCommonStore.getState().clearFrameSelection();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // Never eat a real keypress: typing in a field, or a key meant for an open dialog.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (el?.closest?.('.ant-modal-root')) return;
      const sel = useCommonStore.getState().frameSelection;
      if (frameSelectionSize(sel) === 0) return;
      e.preventDefault();
      confirmDeleteFrameItems(expId, sel, (ids) => removeRef.current(ids));
    };
    document.addEventListener('pointerdown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [expId]);
}
