import { useMemo } from 'react';
import { AutoComplete, Button, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import useCommonStore from '../../stores/common';

// The global header search box, rendered on the home page only. Term + suggestion list live in the
// store (published by HomePage); selecting a suggestion opens that experiment. The grid filtering by
// term happens in HomePage, which reads the same store value.
const HeaderSearch = () => {
  const navigate = useNavigate();
  const term = useCommonStore((state) => state.homeSearchTerm);
  const setTerm = useCommonStore((state) => state.setHomeSearchTerm);
  const items = useCommonStore((state) => state.homeSearchItems);

  const options = useMemo(() => {
    const q = term.trim().toLowerCase();
    const matches = q ? items.filter((i) => (i.label ?? '').toLowerCase().includes(q)) : items;
    return matches.map((i) => ({ value: i.id, label: i.label }));
  }, [items, term]);

  return (
    <Space.Compact style={{ width: 480, maxWidth: '100%' }}>
      <AutoComplete
        options={options}
        value={term}
        onChange={setTerm}
        onSelect={(id: string) => navigate(`/experiments/${id}`)}
        filterOption={false}
        allowClear
        style={{ width: '100%' }}
        placeholder="Search experiments by title, author, subject…"
      />
      <Button type="primary" icon={<SearchOutlined />} />
    </Space.Compact>
  );
};

export default HeaderSearch;
