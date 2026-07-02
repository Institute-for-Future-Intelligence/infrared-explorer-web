import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './header/header';
import Sidebar from './sidebar/sidebar';
import AcceptCookie from '../components/acceptCookie';
import AiChatWidget from '../components/aiChat/AiChatWidget';
import useCommonStore from '../stores/common';
import { useIsMobile } from '../hooks/useIsMobile';

const Layout = () => {
  const location = useLocation();
  const isMobile = useIsMobile();
  const mobileDrawerOpen = useCommonStore((state) => state.mobileDrawerOpen);
  const setMobileDrawerOpen = useCommonStore((state) => state.setMobileDrawerOpen);

  // Always close the mobile drawer on navigation (covers links that bypass the sidebar's own handler).
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname, setMobileDrawerOpen]);

  // Force the drawer closed whenever we're in desktop mode, so a mobile→desktop→mobile resize never
  // leaves the off-canvas drawer stuck open (the flag is otherwise only cleared on nav/backdrop/tap).
  useEffect(() => {
    if (!isMobile) setMobileDrawerOpen(false);
  }, [isMobile, setMobileDrawerOpen]);

  return (
    <div className="app">
      <Header />
      <div className="body">
        <Sidebar />
        {/* Dim backdrop behind the mobile drawer; tapping it closes the drawer. Hidden on desktop. */}
        <div
          className={`sidebar-backdrop ${mobileDrawerOpen ? 'visible' : ''}`}
          onClick={() => setMobileDrawerOpen(false)}
        />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <AcceptCookie />
      {/* Site-wide AI assistant; renders its own bottom-right FAB and self-gates to staff. */}
      <AiChatWidget />
    </div>
  );
};

export default Layout;
