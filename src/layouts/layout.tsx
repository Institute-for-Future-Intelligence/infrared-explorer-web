import { useEffect } from 'react';
import { Outlet, matchPath, useLocation } from 'react-router-dom';
import Header from './header/header';
import Sidebar from './sidebar/sidebar';
import AcceptCookie from '../components/acceptCookie';
import SignInDialog from '../components/signInDialog';
import AiChatWidget from '../components/aiChat/AiChatWidget';
import TopProgressBar from '../components/topProgressBar';
import ScrollMemory from '../components/scrollMemory';
import useCommonStore from '../stores/common';
import { useIsMobile } from '../hooks/useIsMobile';
import { useNavTrailRecorder } from '../hooks/useNavTrail';

const Layout = () => {
  const location = useLocation();
  const isMobile = useIsMobile();
  // Remembers the pages each experiment was opened through, for the analyzer's breadcrumbs.
  useNavTrailRecorder();
  const mobileDrawerOpen = useCommonStore((state) => state.mobileDrawerOpen);
  const setMobileDrawerOpen = useCommonStore((state) => state.setMobileDrawerOpen);
  // The desktop analyzer draws the header in its own left column (<Header inPage />); meanwhile the app
  // skips the full-width one and the body takes the whole window height.
  const headerInPage = useCommonStore((state) => state.headerInPage);
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

  // Whether the drawer shows, as of this render: navigating from the desktop analyzer's drawer leaves the
  // close to the effects above (see Sidebar's go()), so the first frame of a page without a drawer must
  // not paint the dimmed backdrop still flagged open.
  const drawerOpen = drawerMode && mobileDrawerOpen;
  const appClassName = ['app', headerInPage && 'app-header-in-page', drawerOpen && 'app-drawer-open']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={appClassName}>
      {/* Remembers each history entry's scroll offset in `.content` and restores it on Back/Forward. */}
      <ScrollMemory />
      <TopProgressBar />
      {!headerInPage && <Header />}
      <div className="body">
        <Sidebar />
        {/* Dim backdrop behind the mobile drawer; tapping it closes the drawer. Hidden on desktop. */}
        <div className={`sidebar-backdrop ${drawerOpen ? 'visible' : ''}`} onClick={() => setMobileDrawerOpen(false)} />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <AcceptCookie />
      {/* The one provider chooser every "Sign in" affordance opens (services/auth signIn()). */}
      <SignInDialog />
      {/* Site-wide AI assistant; renders its own bottom-right FAB and self-gates to staff. */}
      <AiChatWidget />
    </div>
  );
};

export default Layout;
