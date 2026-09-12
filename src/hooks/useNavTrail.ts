import { useLayoutEffect, useRef } from 'react';
import { Location, matchPath, useLocation, useNavigationType } from 'react-router-dom';
import useCommonStore from '../stores/common';
import { ANALYZER_ROUTE, trailFrom } from '../utils/navTrail';

/**
 * Records, for every analyzer visit, the pages it was reached through (the store's navTrails), for its
 * breadcrumbs. Rendered once in Layout, which sees every navigation. A layout effect: the trail is in the
 * store before the frame paints, so the breadcrumbs never show a stale one.
 */
export const useNavTrailRecorder = () => {
  const location = useLocation();
  const navType = useNavigationType();
  const previous = useRef<Location | null>(null);

  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = location;
    if (!matchPath(ANALYZER_ROUTE, location.pathname)) return;
    const { navTrails, setNavTrail, experimentMap, user } = useCommonStore.getState();
    // Back / Forward onto an entry seen before keeps the trail it was given when it was first opened.
    if (navTrails.has(location.key)) return;
    const trail = trailFrom(from, navType, location.pathname, {
      trailOf: (key) => navTrails.get(key),
      titleOf: (expId) => experimentMap.get(expId)?.displayName,
      userId: user?.id,
    });
    setNavTrail(location.key, trail);
  }, [location, navType]);
};
