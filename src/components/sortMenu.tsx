import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { SortAscendingOutlined, DownOutlined } from '@ant-design/icons';
import { ExperimentDoc } from '../types';

/** Selected order of the home grid. */
export type SortValue = 'newest' | 'oldest' | 'views' | 'rating' | 'comments' | 'title';

/** Sort orders offered by the home toolbar, in menu order. `label` shows in both the menu and the button. */
export const SORT_OPTIONS: { key: SortValue; label: string }[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'views', label: 'Most viewed' },
  { key: 'rating', label: 'Highest rated' },
  { key: 'comments', label: 'Most discussed' },
  { key: 'title', label: 'Title (A–Z)' },
];

const createdMillis = (e: ExperimentDoc) => (e.createdAt ? e.createdAt.toMillis() : 0);
// Mirror the card's average-rating derivation so "Highest rated" matches the star shown on each card.
const ratingAvg = (e: ExperimentDoc) => (e.ratingCount ? (e.ratingSum ?? 0) / e.ratingCount : 0);
const titleText = (e: ExperimentDoc) => (e.displayName ?? '').replace(/<[^>]*>/g, '');

/**
 * Comparator for the chosen sort order. JS sort is stable, so ties keep the incoming Firestore order
 * (createdAt desc) — and "Highest rated" breaks ties by vote count so a well-reviewed 5★ outranks a
 * single-vote 5★.
 */
export const compareExperiments =
  (value: SortValue) =>
  (a: ExperimentDoc, b: ExperimentDoc): number => {
    switch (value) {
      case 'oldest':
        return createdMillis(a) - createdMillis(b);
      case 'views':
        return (b.viewCount ?? 0) - (a.viewCount ?? 0);
      case 'rating':
        return ratingAvg(b) - ratingAvg(a) || (b.ratingCount ?? 0) - (a.ratingCount ?? 0);
      case 'comments':
        return (b.commentCount ?? 0) - (a.commentCount ?? 0);
      case 'title':
        return titleText(a).localeCompare(titleText(b), undefined, { sensitivity: 'base' });
      case 'newest':
      default:
        return createdMillis(b) - createdMillis(a);
    }
  };

interface Props {
  value: SortValue;
  onChange: (value: SortValue) => void;
}

/**
 * Pill dropdown (left of the subject chips) that picks the home grid's sort order. The button shows
 * the active order; the menu marks it selected. Sorting is client-side over the already-loaded list.
 */
const SortMenu = ({ value, onChange }: Props) => {
  const items: MenuProps['items'] = SORT_OPTIONS.map((o) => ({ key: o.key, label: o.label }));
  const activeLabel = SORT_OPTIONS.find((o) => o.key === value)?.label ?? SORT_OPTIONS[0].label;

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomLeft"
      menu={{
        items,
        selectable: true,
        selectedKeys: [value],
        onClick: ({ key }) => onChange(key as SortValue),
      }}
    >
      <button type="button" className="sort-button" aria-label="Sort experiments" aria-haspopup="menu">
        <SortAscendingOutlined />
        {activeLabel}
        <DownOutlined className="sort-button-caret" />
      </button>
    </Dropdown>
  );
};

export default SortMenu;
