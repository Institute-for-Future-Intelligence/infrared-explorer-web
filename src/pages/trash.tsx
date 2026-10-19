import { useMemo, useState } from 'react';
import { Modal, message } from 'antd';
import type { MenuProps } from 'antd';
import { RotateCcw, Trash2 } from 'lucide-react';
import { ExperimentSubjects } from '../types';
import useCommonStore from '../stores/common';
import { deleteExperiment, setTrash } from '../services/experiments';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SortValue, compareExperiments } from '../components/sortMenu';
import ListSearch, { matchesSearch } from '../components/listSearch';
import SelectionBar, { SelectButton } from '../components/selectionBar';
import BackToTop from '../components/backToTop';
import { MENU_ICONS } from '../components/menuIcons';
import { usePersistentState } from '../hooks/usePersistentState';
import { useMultiSelect } from '../hooks/useMultiSelect';
import { useTrashedExperiments, type ExperimentCard } from '../hooks/useExperimentLists';
import { countExperiments as plural, settleEach } from '../utils/bulk';

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// A staff takedown or a report-driven hide holds the owner to trash == true (firestore.rules), so these
// can be deleted but never restored from here.
const isLocked = (e: ExperimentCard) => e.trashedByStaff === true || e.hiddenByReports === true;

const Trash = () => {
  const user = useCommonStore((state) => state.user);
  const { items, setItems } = useTrashedExperiments(user);
  // Sort + subject filter persist across visits (localStorage); the search term stays transient.
  const [subject, setSubject] = usePersistentState<SubjectFilterValue>('trash.subject', 'all');
  const [sort, setSort] = usePersistentState<SortValue>('trash.sort', 'updated');
  // Free-text search over the loaded list (title / author / description / subject).
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);

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
    { key: 'restore', label: 'Restore', icon: MENU_ICONS.restore, onClick: () => restore(item.id) },
    { type: 'divider' },
    {
      key: 'delete',
      label: 'Delete forever',
      icon: MENU_ICONS.delete,
      danger: true,
      onClick: () => removeForever(item.id),
    },
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

  // Multi-select. While selecting, the sort / filter / search band gives way to the selection bar, so
  // the visible list can't change under the selection.
  const sel = useMultiSelect(visible);

  // Drop what a bulk write removed from the trash; whatever didn't go stays selected so it can be dealt
  // with next (a locked card the user tried to restore can then be deleted), and selection ends once
  // nothing is left in it. Empty trash runs outside selection and leaves it alone.
  const afterBulk = (attempted: string[], done: Set<string>) => {
    setItems((prev) => prev.filter((i) => !done.has(i.id)));
    if (sel.selecting) sel.settle(attempted, done);
  };

  const restoreSelected = async () => {
    const { chosen } = sel;
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
    const ids = sel.chosen.map((i) => i.id);
    confirmDelete(
      ids,
      `Delete ${ids.length === 1 ? 'this recording' : `${ids.length} recordings`} forever?`,
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
      {sel.selecting ? (
        <SelectionBar sel={sel}>
          <button type="button" className="list-btn" onClick={restoreSelected} disabled={busy || !sel.chosen.length}>
            <RotateCcw size={15} aria-hidden />
            Restore
          </button>
          <button
            type="button"
            className="list-btn is-danger"
            onClick={deleteSelected}
            disabled={busy || !sel.chosen.length}
          >
            <Trash2 size={15} aria-hidden />
            Delete forever
          </button>
        </SelectionBar>
      ) : (
        <div className="home-toolbar">
          <SortMenu value={sort} onChange={setSort} />
          {availableSubjects.length > 0 && (
            <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
          )}
          <ListSearch value={term} onChange={setTerm} />
          <div className="list-toolbar-actions">
            <SelectButton onClick={sel.start} disabled={visible.length === 0} />
            <button type="button" className="list-btn is-danger" onClick={emptyTrash} disabled={busy}>
              <Trash2 size={15} aria-hidden />
              Empty trash
            </button>
          </div>
        </div>
      )}
      <ExperimentGrid
        items={visible}
        buildMenu={buildMenu}
        selecting={sel.selecting}
        selectedIds={sel.selected}
        onSelect={sel.toggle}
      />
      <BackToTop />
    </div>
  );
};

export default Trash;
