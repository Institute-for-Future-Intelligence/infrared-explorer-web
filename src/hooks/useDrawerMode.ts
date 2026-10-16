import { matchPath, useLocation } from 'react-router-dom';
import { useIsMobile } from './useIsMobile';

// Desktop pages that hide the left nav (YouTube-watch-page style) so the page gets the whole width: the
// Experiment Analyzer and one AI Project (src/pages/labProjects/ProjectPage.tsx). The AI Project list
// (/projects) keeps the in-flow sidebar like the other list pages.
const DRAWER_ROUTES = ['/experiments/:expId', '/projects/:projectId'];

/**
 * Drawer mode = the sidebar is a full-label off-canvas overlay drawer, opened and closed by the header
 * hamburger (`mobileDrawerOpen`), instead of the in-flow expandable / collapsed-rail sidebar. That's
 * mobile (<=768px, every page) AND the DRAWER_ROUTES above on desktop. Layout, Sidebar and Header must
 * agree on it, so they all read it from here.
 */
export const useDrawerMode = (): boolean => {
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  return isMobile || DRAWER_ROUTES.some((route) => !!matchPath(route, pathname));
};
