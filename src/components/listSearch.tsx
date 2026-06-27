import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

// The card fields every experiment list page searches over. All experiment-ish rows (ExperimentDoc,
// GridItem, AdminExperimentRow, history items) carry these, so the predicate is shared.
interface Searchable {
  displayName?: string;
  author?: string;
  description?: string;
  subject?: string | null;
}

/** Case-insensitive substring match over title / author / description / subject. Empty term matches all. */
export const matchesSearch = (item: Searchable, term: string): boolean => {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  return [item.displayName, item.author, item.description, item.subject].some((f) =>
    (f ?? '').toLowerCase().includes(q),
  );
};

interface Props {
  value: string;
  onChange: (term: string) => void;
  placeholder?: string;
}

/** Right-pinned search box for experiment-list toolbars; filters the loaded list client-side. */
const ListSearch = ({ value, onChange, placeholder = 'Search experiments…' }: Props) => (
  <Input
    className="list-search-box"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    allowClear
    prefix={<SearchOutlined />}
    placeholder={placeholder}
  />
);

export default ListSearch;
