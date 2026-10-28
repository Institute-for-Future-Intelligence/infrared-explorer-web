import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { SortAscendingOutlined, DownOutlined } from '@ant-design/icons';
import { ExperimentDoc, Visibility } from '../types';

/** Selected order of the home grid. */
export type SortValue = 'newest' | 'oldest' | 'updated' | 'views' | 'rating' | 'comments' | 'title' | 'visibility';

/** Sort orders offered by the home toolbar, in menu order. `label` shows in both the menu and the button. */
export const SORT_OPTIONS: { key: SortValue; label: string }[] = [
  { key: 'newest', label: 'Recently created' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'views', label: 'Most viewed' },
  { key: 'rating', label: 'Highest rated' },
  { key: 'comments', label: 'Most discussed' },
  { key: 'title', label: 'Title (A–Z)' },
  { key: 'visibility', label: 'By visibility' },
];

/**
 * What a sort order reads off an item. An experiment's come from its document (sortFieldsOf); the home
 * page's collection also holds AI projects, which map their own fields onto these (homePage.tsx).
 */
export interface SortFields {
  createdMillis: number;
  updatedMillis: number;
  viewCount: number;
  ratingAvg: number;
  ratingCount: number;
  commentCount: number;
  /** Plain text, no HTML. */
  title: string;
  /** Lower first: Public, then Link only, then Private. */
  visibilityRank: number;
}

const createdMillis = (e: ExperimentDoc) => (e.createdAt ? e.createdAt.toMillis() : 0);
// "By visibility" groups an owner's clips by tier: Public first, then Link only, then Private. A
// missing tier counts as Link only (the default for saved clips). Ties keep createdAt-desc order.
const VISIBILITY_ORDER: Record<Visibility, number> = {
  [Visibility.Public]: 0,
  [Visibility.Unlisted]: 1,
  [Visibility.Private]: 2,
};

export const sortFieldsOf = (e: ExperimentDoc): SortFields => ({
  createdMillis: createdMillis(e),
  // Last-edit time; docs never edited (or legacy) fall back to createdAt so they still order sensibly.
  updatedMillis: e.updatedAt ? e.updatedAt.toMillis() : createdMillis(e),
  viewCount: e.viewCount ?? 0,
  // Mirror the card's average-rating derivation so "Highest rated" matches the star shown on each card.
  ratingAvg: e.ratingCount ? (e.ratingSum ?? 0) / e.ratingCount : 0,
  ratingCount: e.ratingCount ?? 0,
  commentCount: e.commentCount ?? 0,
  title: (e.displayName ?? '').replace(/<[^>]*>/g, ''),
  visibilityRank: VISIBILITY_ORDER[e.visibility ?? Visibility.Unlisted] ?? 1,
});

/**
 * Comparator for the chosen sort order over the sort fields. JS sort is stable, so ties keep the
 * incoming order (createdAt desc from Firestore) — and "Highest rated" breaks ties by vote count so a
 * well-reviewed 5★ outranks a single-vote 5★.
 */
export const compareSortFields =
  (value: SortValue) =>
  (a: SortFields, b: SortFields): number => {
    switch (value) {
      case 'oldest':
        return a.createdMillis - b.createdMillis;
      case 'updated':
        return b.updatedMillis - a.updatedMillis;
      case 'views':
        return b.viewCount - a.viewCount;
      case 'rating':
        return b.ratingAvg - a.ratingAvg || b.ratingCount - a.ratingCount;
      case 'comments':
        return b.commentCount - a.commentCount;
      case 'title':
        return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
      case 'visibility':
        return a.visibilityRank - b.visibilityRank || b.createdMillis - a.createdMillis;
      case 'newest':
      default:
        return b.createdMillis - a.createdMillis;
    }
  };

/** The comparator over experiment documents (compareSortFields on sortFieldsOf). */
export const compareExperiments = (value: SortValue) => {
  const compare = compareSortFields(value);
  return (a: ExperimentDoc, b: ExperimentDoc): number => compare(sortFieldsOf(a), sortFieldsOf(b));
};

interface Props {
  value: SortValue;
  onChange: (value: SortValue) => void;
  /** Subset/ordering of orders to offer; defaults to the full {@link SORT_OPTIONS} list. */
  options?: { key: SortValue; label: string }[];
}

/**
 * Pill dropdown (left of the subject chips) that picks the home grid's sort order. The button shows
 * the active order; the menu marks it selected. Sorting is client-side over the already-loaded list.
 */
const SortMenu = ({ value, onChange, options = SORT_OPTIONS }: Props) => {
  const items: MenuProps['items'] = options.map((o) => ({ key: o.key, label: o.label }));
  const activeLabel = options.find((o) => o.key === value)?.label ?? options[0].label;

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
      <button type="button" className="sort-button" aria-label="Sort recordings" aria-haspopup="menu">
        <SortAscendingOutlined />
        {activeLabel}
        <DownOutlined className="sort-button-caret" />
      </button>
    </Dropdown>
  );
};

export default SortMenu;
