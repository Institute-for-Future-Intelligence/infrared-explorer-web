import { useState } from 'react';
import { Dropdown, Modal, message } from 'antd';
import { ChevronDown, Eye, Trash2 } from 'lucide-react';
import type { GridItem } from './experimentGrid';
import SelectionBar from '../selectionBar';
import { UNFEATURED_TOAST, consequence, visibilityLabel, visibilityMenuItems } from '../visibilityControl';
import { setTrash, updateVisibility } from '../../services/experiments';
import { countExperiments, settleEach } from '../../utils/bulk';
import type { MultiSelect } from '../../hooks/useMultiSelect';
import useCommonStore from '../../stores/common';
import { Visibility } from '../../types';

interface Props<T extends GridItem> {
  sel: MultiSelect<T>;
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
}

/** "this experiment" / "3 experiments", as a confirm title names what it is about to change. */
const these = (n: number) => (n === 1 ? 'this recording' : countExperiments(n));

/**
 * Selection bar for an owner's own clips (My Experiments / Raw Data), the multi-select counterpart of
 * OwnedExperimentGrid's per-card menu: set the visibility of the selection, or move it to the trash.
 * Both confirm first — a bulk change can't be taken back in one click — and report what landed.
 */
function OwnedSelectionBar<T extends GridItem>({ sel, setItems }: Props<T>) {
  const user = useCommonStore((state) => state.user);
  const [busy, setBusy] = useState(false);
  const { chosen } = sel;
  const idle = !busy && chosen.length > 0;
  // The tier every selected clip already has, if they agree — checkmarked in the picker.
  const shared = chosen.every((it) => it.visibility === chosen[0]?.visibility) ? chosen[0]?.visibility : undefined;

  const setVisibility = (visibility: Visibility) => {
    const targets = chosen.filter((it) => it.visibility !== visibility);
    if (targets.length === 0) return;
    const label = visibilityLabel(visibility);
    Modal.confirm({
      title: `Set ${these(targets.length)} to ${label}?`,
      content: consequence('recording', visibility, targets.length),
      okText: `Set to ${label}`,
      onOk: async () => {
        if (!user) {
          message.error('Sign in to change visibility');
          return;
        }
        setBusy(true);
        try {
          const ids = targets.map((it) => it.id);
          // As in changeVisibility: a featured clip leaving Public loses its homepage `featured` flag in
          // the same write (the showcase only lists public clips). Patched below too, so the cards' star
          // badges follow.
          const leavesShowcase = new Set(
            targets.filter((it) => it.featured && visibility !== Visibility.Public).map((it) => it.id),
          );
          const done = await settleEach(ids, (id) =>
            updateVisibility(id, user, visibility, { unfeature: leavesShowcase.has(id) }),
          );
          setItems((prev) =>
            prev.map((it) =>
              done.has(it.id) ? { ...it, visibility, featured: leavesShowcase.has(it.id) ? false : it.featured } : it,
            ),
          );
          sel.settle(ids, done);
          const failed = ids.length - done.size;
          if (!done.size) message.error('Failed to change visibility');
          else if (failed) {
            message.warning(`Set ${countExperiments(done.size)} to ${label}; ${failed} could not be changed.`);
          } else message.success(`Set ${countExperiments(done.size)} to ${label}`);
          const unfeatured = ids.filter((id) => leavesShowcase.has(id) && done.has(id)).length;
          if (unfeatured) {
            message.info(
              `Removed ${countExperiments(unfeatured)} from the homepage showcase. ${UNFEATURED_TOAST.split('. ')[1]}`,
            );
          }
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const moveToTrash = () => {
    const ids = chosen.map((it) => it.id);
    Modal.confirm({
      title: `Move ${these(ids.length)} to the trash?`,
      okText: 'Move to trash',
      okButtonProps: { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          const done = await settleEach(ids, (id) => setTrash(id, true));
          setItems((prev) => prev.filter((it) => !done.has(it.id)));
          sel.settle(ids, done);
          const failed = ids.length - done.size;
          if (!done.size) message.error('Failed to move to trash');
          else if (failed) {
            message.warning(`Moved ${countExperiments(done.size)} to the trash; ${failed} could not be moved.`);
          } else message.success(`Moved ${countExperiments(done.size)} to the trash`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <SelectionBar sel={sel}>
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        disabled={!idle}
        menu={{ items: visibilityMenuItems(shared, setVisibility) }}
      >
        <button type="button" className="list-btn" disabled={!idle} aria-haspopup="menu">
          <Eye size={15} aria-hidden />
          Visibility
          <ChevronDown size={14} aria-hidden />
        </button>
      </Dropdown>
      <button type="button" className="list-btn is-danger" onClick={moveToTrash} disabled={!idle}>
        <Trash2 size={15} aria-hidden />
        Move to trash
      </button>
    </SelectionBar>
  );
}

export default OwnedSelectionBar;
