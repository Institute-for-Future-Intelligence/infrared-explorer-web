import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MenuOutlined } from '@ant-design/icons';
import { matchPath, useLocation } from 'react-router-dom';
import AccountSection from './accountSection.tsx';
import Title from './title.tsx';
import HeaderSearch from './headerSearch.tsx';
import useCommonStore from '../../stores/common.ts';
import { useIsMobile } from '../../hooks/useIsMobile.ts';
import { getPageTitle } from '../../utils/pageTitles.ts';

type HeaderProps = {
  // Rendered by a page inside its own layout instead of across the top by Layout: the desktop Experiment
  // Analyzer puts it over the player, so the workspace card can take the full height beside it. While an
  // in-page header is mounted, Layout leaves its own out.
  inPage?: boolean;
};

const Header = React.memo(({ inPage = false }: HeaderProps) => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const currentUserId = useCommonStore((state) => state.user?.id);
  const pageTitle = getPageTitle(location.pathname, currentUserId);
  const isMobile = useIsMobile();
  const toggleSidebar = useCommonStore((state) => state.toggleSidebar);
  const toggleMobileDrawer = useCommonStore((state) => state.toggleMobileDrawer);
  const setHeaderInPage = useCommonStore((state) => state.setHeaderInPage);
  // Drawer mode = the sidebar is an off-canvas overlay drawer, so the hamburger opens/closes it. That's
  // mobile (<=768px, any page) AND the desktop Experiment Analyzer (YouTube-style hidden nav). Elsewhere
  // on desktop the hamburger collapses/expands the in-flow sidebar.
  const isAnalyzer = !!matchPath('/experiments/:expId', location.pathname);
  const drawerMode = isMobile || isAnalyzer;

  // In-page only: the header is a card in the page while the grid cell it sits in (slotRef) is on screen.
  // Once the page scrolls past that, it docks as the old full-width bar fixed across the top of the window,
  // so navigation and the account stay in reach below the fold, and it undocks when the cell scrolls back
  // into view. `right` keeps the docked bar clear of the page's scrollbar.
  const slotRef = useRef<HTMLDivElement>(null);
  const [dock, setDock] = useState<{ right: number } | null>(null);
  // Decided from where the cell is now, not from an observer entry: a busy main thread can hand the
  // observer both crossings of a quick flick in one batch, and the oldest would be the wrong one.
  const syncDock = useCallback(() => {
    const slot = slotRef.current;
    const scroller = slot?.closest<HTMLElement>('.content');
    if (!slot || !scroller) return;
    const scrolledPast = slot.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top;
    const right = scroller.offsetWidth - scroller.clientWidth;
    setDock((d) => (!scrolledPast ? null : d && d.right === right ? d : { right }));
  }, []);
  useEffect(() => {
    const slot = slotRef.current;
    const scroller = slot?.closest<HTMLElement>('.content');
    if (!inPage || !slot || !scroller) return;
    const observer = new IntersectionObserver(syncDock, { root: scroller });
    observer.observe(slot);
    // The scroller changing size — a zoom, or its scrollbar coming or going — moves the docked bar's
    // right edge without the cell crossing anything.
    const resizes = new ResizeObserver(syncDock);
    resizes.observe(scroller);
    return () => {
      observer.disconnect();
      resizes.disconnect();
    };
  }, [inPage, syncDock]);
  // A new page (history entry) resets or restores the scroll (ScrollMemory, whose layout effect runs
  // before this one): match it before the frame paints, rather than show the last page's mode first.
  useLayoutEffect(() => {
    if (inPage) syncDock();
  }, [inPage, location.key, syncDock]);
  // An open header menu (notifications, account) stays where it was anchored when the header changes
  // mode under it; its popup realigns on its trigger's scroll parent scrolling, so nudge that — once the
  // mode has changed, and again when the docked bar has finished sliding in.
  const realignMenus = useCallback(() => {
    slotRef.current?.closest('.content')?.dispatchEvent(new Event('scroll'));
  }, []);
  const docked = !!dock;
  const dockedBefore = useRef(docked);
  useLayoutEffect(() => {
    if (dockedBefore.current === docked) return;
    dockedBefore.current = docked;
    realignMenus();
  }, [docked, realignMenus]);

  const onHamburger = () => {
    if (!drawerMode) return toggleSidebar();
    // Opening from the card while the page is part-scrolled: bring the card fully back first, so the
    // drawer (fixed under where the card sits on an unscrolled page) hangs right under it.
    if (inPage && !dock && !useCommonStore.getState().mobileDrawerOpen) {
      slotRef.current?.closest('.content')?.scrollTo({ top: 0 });
    }
    toggleMobileDrawer();
  };

  // Claim the header slot for as long as this in-page header is mounted. A layout effect, so Layout
  // drops (and later restores) its own header before the frame paints — never two headers, never none.
  useLayoutEffect(() => {
    if (!inPage) return;
    setHeaderInPage(true);
    return () => setHeaderInPage(false);
  }, [inPage, setHeaderInPage]);

  const className = inPage ? `header header-in-page${dock ? ' header-docked' : ''}` : 'header';
  return (
    <>
      {inPage && <div ref={slotRef} className="header-in-page-slot" />}
      <header
        className={className}
        style={dock ? { right: dock.right } : undefined}
        onAnimationEnd={(e) => e.target === e.currentTarget && realignMenus()}
      >
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
    </>
  );
});

export default Header;
