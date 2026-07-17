import { useEffect } from 'react';
import { Outlet, matchPath, useLocation } from 'react-router-dom';
import Header from './header/header';
import Sidebar from './sidebar/sidebar';
import AcceptCookie from '../components/acceptCookie';
import AiChatWidget from '../components/aiChat/AiChatWidget';
import TopProgressBar from '../components/topProgressBar';
import useCommonStore from '../stores/common';
import { useIsMobile } from '../hooks/useIsMobile';

const Layout = () => {
  const location = useLocation();
  const isMobile = useIsMobile();
  const mobileDrawerOpen = useCommonStore((state) => state.mobileDrawerOpen);
  const setMobileDrawerOpen = useCommonStore((state) => state.setMobileDrawerOpen);
  // Drawer mode = the sidebar is an overlay drawer: mobile (any page) OR the desktop Experiment Analyzer.
  const drawerMode = isMobile || !!matchPath('/experiments/:expId', location.pathname);

  // Always close the drawer on navigation (covers links that bypass the sidebar's own handler, and
  // leaving the analyzer).
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname, setMobileDrawerOpen]);

  // Force the drawer closed whenever we're NOT in drawer mode, so a resize (or navigating from the
  // analyzer to a normal desktop page) never leaves the off-canvas drawer stuck open. Keeps the drawer
  // usable on the desktop analyzer.
  useEffect(() => {
    if (!drawerMode) setMobileDrawerOpen(false);
  }, [drawerMode, setMobileDrawerOpen]);

  return (
    <div className="app">
      <TopProgressBar />
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
