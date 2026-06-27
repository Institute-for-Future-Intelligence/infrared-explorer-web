import { useState } from 'react';
import { Dropdown } from 'antd';
import { DownOutlined, TagsOutlined } from '@ant-design/icons';
import { ExperimentSubjects } from '../types';
import { SUBJECT_META } from './card/subjectMeta';

interface Props {
  /** Currently-checked subjects; an empty array means "no filter" (show every subject). */
  value: ExperimentSubjects[];
  /** Which subject options to offer — usually only the disciplines present in the loaded data. */
  subjects: ExperimentSubjects[];
  onChange: (value: ExperimentSubjects[]) => void;
}

/**
 * Pill dropdown that filters a grid by one or more subjects. Shares the `.sort-button` styling with
 * {@link SortMenu} / {@link RecencyFilter} so the three sit as a matched toolbar row. Unlike the
 * home page's chip row this is multi-select: the menu stays open while ticking subjects, and the
 * leading "All subjects" entry clears the selection. An empty selection means no filter.
 */
const SubjectMultiFilter = ({ value, subjects, onChange }: Props) => {
  const [open, setOpen] = useState(false);

  const toggle = (s: ExperimentSubjects) => onChange(value.includes(s) ? value.filter((v) => v !== s) : [...value, s]);

  // Button label: "All subjects" when nothing is ticked, otherwise the checked labels in offered order.
  const label =
    value.length === 0
      ? 'All subjects'
      : subjects
          .filter((s) => value.includes(s))
          .map((s) => SUBJECT_META[s]?.label ?? s)
          .join(', ');

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomLeft"
      open={open}
      // Keep the menu open while ticking subjects (source === 'menu'); close on outside click / the trigger.
      onOpenChange={(next, info) => {
        if (info.source === 'menu') return;
        setOpen(next);
      }}
      menu={{
        multiple: true,
        selectable: true,
        selectedKeys: value,
        items: [
          { key: 'all', label: 'All subjects' },
          { type: 'divider' },
          ...subjects.map((s) => ({
            key: s,
            label: (
              <span>
                <span className="subject-chip-icon">{SUBJECT_META[s]?.icon}</span>
                {SUBJECT_META[s]?.label ?? s}
              </span>
            ),
          })),
        ],
        onClick: ({ key }) => (key === 'all' ? onChange([]) : toggle(key as ExperimentSubjects)),
      }}
    >
      <button type="button" className="sort-button" aria-label="Filter by subject" aria-haspopup="menu">
        <TagsOutlined />
        {label}
        <DownOutlined className="sort-button-caret" />
      </button>
    </Dropdown>
  );
};

export default SubjectMultiFilter;
