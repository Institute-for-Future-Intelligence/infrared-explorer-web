import React from 'react';
import { MenuOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import AccountSection from './accountSection.tsx';
import Title from './title.tsx';
import HeaderSearch from './headerSearch.tsx';
import useCommonStore from '../../stores/common.ts';

const Header = React.memo(() => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const toggleSidebar = useCommonStore((state) => state.toggleSidebar);

  return (
    <header className="header">
      {/* The hamburger zone's width tracks the sidebar, so the brand that follows lines up with the
          content/cards (which start at sidebar width + content padding). */}
      <div className="header-ham">
        <button className="hamburger" aria-label="Toggle navigation" onClick={toggleSidebar}>
          <MenuOutlined />
        </button>
      </div>
      <Title />
      {/* Search lives in the header but is a home-page feature, so it only renders there. */}
      <div className="header-center">{isHome && <HeaderSearch />}</div>
      <div className="header-right">
        <AccountSection />
      </div>
    </header>
  );
});

export default Header;
