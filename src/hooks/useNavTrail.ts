import { useCallback, useLayoutEffect, useRef } from 'react';
import { Location, NavigationType, useLocation, useNavigationType } from 'react-router-dom';
import type { NavCrumb } from '../stores/common';
import useCommonStore from '../stores/common';
import { titleOf as projectTitleOf } from '../labProjects/store';
import { hasNavTrail, trailFrom } from '../utils/navTrail';

/**
 * Records, for every analyzer or AI Project visit, the pages it was reached through (the store's
 * navTrails), for its breadcrumbs. Rendered once in Layout, which sees every navigation. A layout effect:
 * the trail is in the store before the frame paints, so the breadcrumbs never show a stale one.
 */
export const useNavTrailRecorder = () => {
  const location = useLocation();
  const navType = useNavigationType();
  const previous = useRef<Location | null>(null);

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = location;
    if (!hasNavTrail(location.pathname)) return;
    const { navTrails, setNavTrail, experimentMap, user } = useCommonStore.getState();
    // Back / Forward onto an entry seen before keeps the trail it was given when it was first opened.
    if (navTrails.has(location.key)) return;
    // A tab's first page, opened in a new tab by a link that handed it a trail (useNewTabLink).
    const handed = from ? undefined : takeHandedOffTrail(location.pathname);
    if (handed) {
      setNavTrail(location.key, handed);
      return;
    }
    const trail = trailFrom(from, navType, location.pathname, {
      trailOf: (key) => navTrails.get(key),
      titleOf: (expId) => experimentMap.get(expId)?.displayName,
      projectTitleOf,
      userId: user?.id,
    });
    setNavTrail(location.key, trail);
  }, [location, navType]);
};

// A link opened in a new tab starts a tab with no history, so its page would have no trail. The link hands
// the trail it would have had over through localStorage (shared by the tabs, unlike sessionStorage), and the
// new tab's first page takes it — once, and only soon after the click.
const HANDOFF_KEY = 'navTrailHandoff';
const HANDOFF_MAX_AGE_MS = 15_000;

const handOffTrail = (pathname: string, trail: NavCrumb[]) => {
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ pathname, trail, at: Date.now() }));
  } catch {
    // Storage blocked: the new tab's breadcrumbs start at Home.
  }
};

const takeHandedOffTrail = (pathname: string): NavCrumb[] | undefined => {
  try {
    const saved = JSON.parse(localStorage.getItem(HANDOFF_KEY) ?? 'null');
    if (!saved || saved.pathname !== pathname || !Array.isArray(saved.trail)) return undefined;
    localStorage.removeItem(HANDOFF_KEY);
    return Date.now() - saved.at < HANDOFF_MAX_AGE_MS ? saved.trail : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Props for a <Link> that opens `to` (a page with breadcrumbs) in a new tab, with the breadcrumbs it would
 * have had opened in this one: e.g. a recording opened from an AI Project's captures keeps the project.
 */
export const useNewTabLink = () => {
  const location = useLocation();
  return useCallback(
    (to: string) => ({
      to,
      target: '_blank',
      rel: 'noopener',
      onClick: () => {
        const { navTrails, experimentMap, user } = useCommonStore.getState();
        const pathname = to.split('?')[0];
        handOffTrail(
          pathname,
          trailFrom(location, NavigationType.Push, pathname, {
            trailOf: (key) => navTrails.get(key),
            titleOf: (expId) => experimentMap.get(expId)?.displayName,
            projectTitleOf,
            userId: user?.id,
          }),
        );
      },
    }),
    [location],
  );
};
