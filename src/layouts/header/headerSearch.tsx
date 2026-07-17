import { useEffect, useMemo, useRef } from 'react';
import { AutoComplete, Button, Space } from 'antd';
import type { RefSelectProps } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import useCommonStore from '../../stores/common';
import { useIsMobile } from '../../hooks/useIsMobile';

// The global header search box, rendered on the home page only. Term + suggestion list live in the
// store (published by HomePage); selecting a suggestion opens that experiment. The grid filtering by
// term happens in HomePage, which reads the same store value.
const HeaderSearch = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const term = useCommonStore((state) => state.homeSearchTerm);
  const setTerm = useCommonStore((state) => state.setHomeSearchTerm);
  const items = useCommonStore((state) => state.homeSearchItems);
  const acRef = useRef<RefSelectProps>(null);

  const options = useMemo(() => {
    const q = term.trim().toLowerCase();
    const matches = q ? items.filter((i) => (i.label ?? '').toLowerCase().includes(q)) : items;
    return matches.map((i) => ({ value: i.id, label: i.label }));
  }, [items, term]);

  // "/" focuses the search from anywhere on the page (skipping when already typing in a field, and
  // during IME composition so it can't hijack a Chinese/Japanese input). Esc blurs it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.isComposing) {
        const el = document.activeElement as HTMLElement | null;
        const editable = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
        if (!editable) {
          e.preventDefault();
          acRef.current?.focus();
        }
      } else if (e.key === 'Escape') {
        acRef.current?.blur();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const search = (
    <AutoComplete
      ref={acRef}
      options={options}
      value={term}
      onChange={setTerm}
      onSelect={(id: string) => navigate(`/experiments/${id}`)}
      filterOption={false}
      allowClear
      style={{ width: '100%' }}
      // The clear/search icon makes intent obvious on mobile where the standalone button is dropped.
      {...(isMobile ? { suffixIcon: <SearchOutlined /> } : {})}
      placeholder="Search experiments by title, author, subject…"
    />
  );

  // On mobile the search fills its (capped) header slot and drops the separate primary button, which
  // would otherwise overflow the slot and shove the account/Sign-In control off the right edge.
  if (isMobile) {
    return <div style={{ width: '100%', minWidth: 0 }}>{search}</div>;
  }

  // Desktop: the box eases wider on focus, and a "/" hint sits at the right until you focus it.
  return (
    <div className="header-search">
      <Space.Compact style={{ width: '100%' }}>
        {search}
        <Button type="primary" icon={<SearchOutlined />} />
      </Space.Compact>
      <kbd className="header-search-kbd" aria-hidden>
        /
      </kbd>
    </div>
  );
};

export default HeaderSearch;
