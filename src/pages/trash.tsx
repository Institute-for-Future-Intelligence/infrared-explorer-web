import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { RotateCcw, SquareCheckBig, Trash2, X } from 'lucide-react';
import { ExperimentSubjects } from '../types';
import useCommonStore from '../stores/common';
import { deleteExperiment, setTrash } from '../services/experiments';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import BackToTop from '../components/backToTop';
import { usePersistentState } from '../hooks/usePersistentState';
import { useTrashedExperiments, type ExperimentCard } from '../hooks/useExperimentLists';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

const plural = (n: number) => `${n} experiment${n === 1 ? '' : 's'}`;

// A staff takedown or a report-driven hide holds the owner to trash == true (firestore.rules), so these
// can be deleted but never restored from here.
const isLocked = (e: ExperimentCard) => e.trashedByStaff === true || e.hiddenByReports === true;

/**
 * One write per id, all in flight at once. allSettled, not all: one doc the rules refuse must not hide
 * that the rest went through — the caller drops exactly the ids that landed.
 */
async function settleEach(ids: string[], write: (id: string) => Promise<void>): Promise<Set<string>> {
  const results = await Promise.allSettled(ids.map(write));
  const done = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') done.add(ids[i]);
    else console.error('trash bulk write failed', ids[i], r.reason);
  });
  return done;
}

const Trash = () => {
  const user = useCommonStore((state) => state.user);
  const { items, setItems } = useTrashedExperiments(user);
  // Sort + subject filter persist across visits (localStorage); the search term stays transient.
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('trash.subject', 'all');
  const [sort, setSort] = usePersistentState<SortValue>('trash.sort', 'updated');
  // Free-text search over the loaded list (title / author / description / subject).
  const [term, setTerm] = useState('');
  // Multi-select. While selecting, the sort / filter / search band gives way to the selection bar, so
  // the visible list can't change under the selection: selected ⊆ visible holds throughout.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  // The last card clicked — a Shift+click takes in every card between it and this one.
  const anchorRef = useRef<string | null>(null);

  const restore = async (id: string) => {
    try {
      await setTrash(id, false);
      setItems((prev) => prev.filter((i) => i.id !== id));
      message.success('Restored');
    } catch (err) {
      console.error('failed to restore', err);
      message.error('Failed to restore');
    }
  };

  const removeForever = (id: string) =>
    Modal.confirm({
      title: 'Delete this forever?',
      content: 'This cannot be undone.',
      okText: 'Delete forever',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteExperiment(id);
          setItems((prev) => prev.filter((i) => i.id !== id));
          message.success('Deleted');
        } catch (err) {
          console.error('failed to delete', err);
          message.error('Failed to delete');
        }
      },
    });

  const buildMenu = (item: GridItem): MenuProps['items'] => [
    { key: 'restore', label: 'Restore', onClick: () => restore(item.id) },
    { type: 'divider' },
    { key: 'delete', label: 'Delete forever', danger: true, onClick: () => removeForever(item.id) },
  ];

  // Subject chips to offer: only the disciplines actually present in the loaded items, in the fixed
  // badge order — so an empty "Biology" filter never shows when nothing is tagged Biology.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      items.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [items]);

  // Apply the subject + search filters, then sort client-side. Restore/delete mutations still target `items`.
  const visible = useMemo(
    () =>
      items
        .filter((s) => (subject === 'all' || s.subject === subject) && matchesSearch(s, term))
        .sort(compareExperiments(sort)),
    [items, subject, sort, term],
  );

  const allSelected = visible.length > 0 && visible.every((i) => selected.has(i.id));

  const startSelecting = () => {
    setSelected(new Set());
    anchorRef.current = null;
    setSelecting(true);
  };
  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  const toggleSelect = useCallback(
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

  // Esc leaves selection; Ctrl/⌘+A selects every card shown. Neither while a dialog has the focus (its
  // own Esc closes it) or while typing somewhere else on the page (the assistant's chat box).
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.ant-modal-wrap, input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'Escape') stopSelecting();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(visible.map((i) => i.id)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, stopSelecting, visible]);

  // Drop what a bulk write removed from the trash; whatever didn't go stays selected so it can be dealt
  // with next (a locked card the user tried to restore can then be deleted), and selection ends once
  // nothing is left in it. Empty trash runs outside selection and leaves it alone.
  const afterBulk = (attempted: string[], done: Set<string>) => {
    setItems((prev) => prev.filter((i) => !done.has(i.id)));
    if (!selecting) return;
    const left = attempted.filter((id) => !done.has(id));
    if (left.length === 0) stopSelecting();
    else setSelected(new Set(left));
  };

  const restoreSelected = async () => {
    const chosen = visible.filter((i) => selected.has(i.id));
    const locked = chosen.filter(isLocked).length;
    const ids = chosen.filter((i) => !isLocked(i)).map((i) => i.id);
    setBusy(true);
    try {
      const done = await settleEach(ids, (id) => setTrash(id, false));
      const chosenIds = chosen.map((i) => i.id);
      afterBulk(chosenIds, done);
      const failed = ids.length - done.size;
      if (!failed && !locked) {
        message.success(`Restored ${plural(done.size)}`);
        return;
      }
      const parts: string[] = [];
      if (done.size) parts.push(`Restored ${plural(done.size)}.`);
      if (failed) parts.push(`${failed} could not be restored.`);
      if (locked) {
        parts.push(
          `${plural(locked)} ${locked === 1 ? 'was' : 'were'} removed from the site by a moderator or after ` +
            `reports — ${locked === 1 ? 'it' : 'they'} can only be deleted.`,
        );
      }
      message.warning(parts.join(' '), locked ? 6 : undefined);
    } finally {
      setBusy(false);
    }
  };

  // Shared by "Delete forever" on the selection and "Empty trash": confirm, then delete, keeping the
  // dialog's OK spinning until every write has settled.
  const confirmDelete = (ids: string[], title: string, content: string, okText: string) =>
    Modal.confirm({
      title,
      content,
      okText,
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          const done = await settleEach(ids, deleteExperiment);
          afterBulk(ids, done);
          const failed = ids.length - done.size;
          if (failed) message.warning(`Deleted ${plural(done.size)}; ${failed} could not be deleted.`);
          else message.success(`Deleted ${plural(done.size)}`);
        } finally {
          setBusy(false);
        }
      },
    });

  const deleteSelected = () => {
    const ids = visible.filter((i) => selected.has(i.id)).map((i) => i.id);
    confirmDelete(
      ids,
      `Delete ${ids.length === 1 ? 'this experiment' : `${ids.length} experiments`} forever?`,
      'This cannot be undone.',
      'Delete forever',
    );
  };

  // Empties the whole trash, not just what the filter / search shows — say so when they differ.
  const emptyTrash = () => {
    const hidden = items.length - visible.length;
    confirmDelete(
      items.map((i) => i.id),
      'Empty the trash?',
      `All ${plural(items.length)} in the trash will be deleted forever${
        hidden > 0 ? `, including ${hidden} not shown by the current filter` : ''
      }. This cannot be undone.`,
      'Empty trash',
    );
  };

  if (!user) return <div>Please sign in to view your trash.</div>;

  return items.length === 0 ? (
    <div style={{ padding: 16 }}>Trash is empty</div>
  ) : (
    <div className="my-experiments-page">
      {selecting ? (
        <div className="home-toolbar trash-select-bar">
          <button type="button" className="trash-select-close" onClick={stopSelecting} aria-label="Exit selection">
            <X size={18} aria-hidden />
          </button>
          <span className="trash-select-count" aria-live="polite">
            {selected.size} selected
          </span>
          <button type="button" className="trash-btn" onClick={toggleAll} disabled={visible.length === 0}>
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
          <div className="trash-select-actions">
            <button type="button" className="trash-btn" onClick={restoreSelected} disabled={busy || !selected.size}>
              <RotateCcw size={15} aria-hidden />
              Restore
            </button>
            <button
              type="button"
              className="trash-btn is-danger"
              onClick={deleteSelected}
              disabled={busy || !selected.size}
            >
              <Trash2 size={15} aria-hidden />
              Delete forever
            </button>
          </div>
        </div>
      ) : (
        <div className="home-toolbar">
          <SortMenu value={sort} onChange={setSort} />
          {availableSubjects.length > 0 && (
            <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
          )}
          <ListSearch value={term} onChange={setTerm} />
          <div className="trash-toolbar-actions">
            <button type="button" className="trash-btn" onClick={startSelecting} disabled={visible.length === 0}>
              <SquareCheckBig size={15} aria-hidden />
              Select
            </button>
            <button type="button" className="trash-btn is-danger" onClick={emptyTrash} disabled={busy}>
              <Trash2 size={15} aria-hidden />
              Empty trash
            </button>
          </div>
        </div>
      )}
      <ExperimentGrid
        items={visible}
        buildMenu={buildMenu}
        selecting={selecting}
        selectedIds={selected}
        onSelect={toggleSelect}
      />
      <BackToTop />
    </div>
  );
};

export default Trash;
