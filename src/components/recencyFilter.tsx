import { Dropdown } from 'antd';
import { ClockCircleOutlined, DownOutlined } from '@ant-design/icons';

/** Selected recency window: a number of days back, or 'all' for no time bound. */
export type RecencyValue = number | 'all';

/** "Within the last …" choices, in menu order. `value` is the day count the page filters by. */
export const RECENCY_OPTIONS: { value: RecencyValue; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: 1, label: 'Last 24 hours' },
  { value: 3, label: 'Last 3 days' },
  { value: 7, label: 'Last week' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
];

interface Props {
  value: RecencyValue;
  onChange: (value: RecencyValue) => void;
}

/**
 * Pill dropdown that narrows a grid to items touched within the last N days. Shares the `.sort-button`
 * styling with {@link SortMenu} so the two sit as a matched pair in a toolbar. Which timestamp it
 * filters (updated / viewed) is the caller's choice — this only picks the window.
 */
const RecencyFilter = ({ value, onChange }: Props) => (
  <Dropdown
    trigger={['click']}
    placement="bottomLeft"
    menu={{
      items: RECENCY_OPTIONS.map((o) => ({ key: String(o.value), label: o.label })),
      selectable: true,
      selectedKeys: [String(value)],
      onClick: ({ key }) => onChange(key === 'all' ? 'all' : Number(key)),
    }}
  >
    <button type="button" className="sort-button" aria-label="Filter by time" aria-haspopup="menu">
      <ClockCircleOutlined />
      {RECENCY_OPTIONS.find((o) => o.value === value)?.label}
      <DownOutlined className="sort-button-caret" />
    </button>
  </Dropdown>
);

export default RecencyFilter;
