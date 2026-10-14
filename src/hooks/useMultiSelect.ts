import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface MultiSelect<T> {
  selecting: boolean;
  selected: ReadonlySet<string>;
  /** The selected cards that are on screen, in display order — what a bulk action acts on. */
  chosen: T[];
  /** How many cards are on screen (0 → nothing to Select all). */
  total: number;
  allSelected: boolean;
  start: () => void;
  stop: () => void;
  /** Toggle one card; `range` (Shift held) takes in every card between it and the last one clicked. */
  toggle: (id: string, range: boolean) => void;
  toggleAll: () => void;
  /**
   * After a bulk write: whatever didn't go through stays selected so it can be dealt with next, and
   * selection ends once nothing is left in it.
   */
  settle: (attempted: string[], done: ReadonlySet<string>) => void;
}

/**
 * Multi-select over a page's card list (Trash, My Experiments, Raw Data). `visible` is the list as
 * shown, in display order: ranges, Select all and Ctrl/⌘+A all work over it, and `chosen` is the
 * selection narrowed to it, so a bulk action never reaches a card that isn't on screen. The page swaps
 * its sort / filter / search band for the selection bar while `selecting`, which keeps the list from
 * changing under the selection.
 */
export function useMultiSelect<T extends { id: string }>(visible: T[]): MultiSelect<T> {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // The last card clicked — a Shift+click takes in every card between it and this one.
  const anchorRef = useRef<string | null>(null);

  const chosen = useMemo(() => visible.filter((i) => selected.has(i.id)), [visible, selected]);
  const allSelected = visible.length > 0 && chosen.length === visible.length;

  const start = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
    setSelecting(true);
  }, []);
  const stop = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const toggle = useCallback(
    (id: string, range: boolean) => {
      const anchor = anchorRef.current;
      anchorRef.current = id;
      setSelected((prev) => {
        const next = new Set(prev);
        // A range takes the state the clicked card is toggling to, so Shift+click both extends a
        // selection and clears a run of it.
        const on = !prev.has(id);
        const from = range && anchor ? visible.findIndex((i) => i.id === anchor) : -1;
        const to = visible.findIndex((i) => i.id === id);
        const span =
          from >= 0 && to >= 0 ? visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => i.id) : [id];
        span.forEach((s) => (on ? next.add(s) : next.delete(s)));
        return next;
      });
    },
    [visible],
  );

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(visible.map((i) => i.id)));
  }, [allSelected, visible]);

  const settle = useCallback(
    (attempted: string[], done: ReadonlySet<string>) => {
      const left = attempted.filter((id) => !done.has(id));
      if (left.length === 0) stop();
      else setSelected(new Set(left));
    },
    [stop],
  );

  // Esc leaves selection; Ctrl/⌘+A selects every card shown. Neither while a dialog has the focus (its
  // own Esc closes it) or while typing somewhere else on the page (the assistant's chat box).
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.ant-modal-wrap, input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        // An open menu (the selection bar's Visibility picker) takes this Esc to close itself.
        if (!document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden)')) stop();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(visible.map((i) => i.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, stop, visible]);

  return { selecting, selected, chosen, total: visible.length, allSelected, start, stop, toggle, toggleAll, settle };
}
