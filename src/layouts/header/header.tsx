import React from 'react';
import { MenuOutlined } from '@ant-design/icons';
import { matchPath, useLocation } from 'react-router-dom';
import AccountSection from './accountSection.tsx';
import Title from './title.tsx';
import HeaderSearch from './headerSearch.tsx';
import useCommonStore from '../../stores/common.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';

// Title shown centered in the header for each page (Home shows the search box instead). Labels match
// the sidebar nav; dynamic routes are matched by pattern.
const PAGE_TITLES: { pattern: string; title: string }[] = [
  { pattern: '/myExperimentsList', title: 'My Experiments' },
  { pattern: '/classroom/:classId', title: 'Class' },
  { pattern: '/classroom', title: 'My Classes' },
  { pattern: '/recent', title: 'History' },
  { pattern: '/raw', title: 'Raw Data' },
  { pattern: '/trash', title: 'Trash' },
  { pattern: '/settings', title: 'Settings' },
  { pattern: '/about', title: 'About' },
  { pattern: '/contact', title: 'Contact Us' },
  { pattern: '/admin/experiments', title: 'All Experiments' },
  { pattern: '/admin/users/:ownerId/experiments', title: 'User Experiments' },
  { pattern: '/admin/users', title: 'All Users' },
  { pattern: '/experiments/:expId', title: 'Experiment Analyzer' },
  { pattern: '/users/:userId', title: 'User Profile' },
];

const getPageTitle = (pathname: string): string | undefined =>
  PAGE_TITLES.find((p) => matchPath(p.pattern, pathname))?.title;

const Header = React.memo(() => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const pageTitle = getPageTitle(location.pathname);
  const isMobile = useIsMobile();
  const toggleSidebar = useCommonStore((state) => state.toggleSidebar);
  const toggleMobileDrawer = useCommonStore((state) => state.toggleMobileDrawer);
  // On desktop the hamburger collapses/expands the in-flow sidebar; on mobile (<=768px) the sidebar is
  // an off-canvas drawer, so it opens/closes that overlay instead.
  const onHamburger = () => (isMobile ? toggleMobileDrawer() : toggleSidebar());

  return (
    <header className="header">
      {/* The hamburger zone's width tracks the sidebar, so the brand that follows lines up with the
          content/cards (which start at sidebar width + content padding). */}
      <div className="header-ham">
        <button className="hamburger" aria-label="Toggle navigation" onClick={onHamburger}>
          <MenuOutlined />
        </button>
      </div>
      <Title />
      {/* Center slot: the search box on Home, otherwise the current page's name. */}
      <div className="header-center">
        {isHome ? <HeaderSearch /> : pageTitle && <h2 className="page-title">{pageTitle}</h2>}
      </div>
      <div className="header-right">
        <AccountSection />
      </div>
    </header>
  );
});

export default Header;
