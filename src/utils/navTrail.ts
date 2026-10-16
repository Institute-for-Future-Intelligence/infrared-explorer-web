import { matchPath, NavigationType } from 'react-router-dom';
import type { NavCrumb } from '../stores/common';
import { getPageTitle } from './pageTitles';

export const ANALYZER_ROUTE = '/experiments/:expId';
// One AI Project (src/pages/labProjects/ProjectPage.tsx), which shows the same breadcrumbs over its title.
export const PROJECT_ROUTE = '/projects/:projectId';

/** The pages with breadcrumbs (components/breadcrumbs.tsx): an experiment in the analyzer, an AI Project. */
export const hasNavTrail = (pathname: string) =>
  !!matchPath(ANALYZER_ROUTE, pathname) || !!matchPath(PROJECT_ROUTE, pathname);

/** The slice of a history entry the trail needs (React Router's Location has these). */
export type TrailLocation = { key: string; pathname: string; search: string };

/** What the trail reads from the app's state. */
export type TrailContext = {
  trailOf: (key: string) => NavCrumb[] | undefined; // the trail recorded for an earlier entry
  titleOf: (expId: string) => string | undefined; // a loaded experiment's title
  userId?: string; // the signed-in user, to tell "My Profile" from someone else's
};

const isExperimentPath = (path: string) => !!matchPath(ANALYZER_ROUTE, path.split('?')[0]);

/** The page an entry was left from, as a breadcrumb step (none for Home — the trail always starts there). */
const pageCrumb = (from: TrailLocation, userId: string | undefined): NavCrumb | null => {
  if (from.pathname === '/') return null;
  const to = from.pathname + from.search;
  const author = matchPath('/showcase/authors/:author', from.pathname)?.params.author;
  if (author) return { label: decodeURIComponent(author), to };
  const label = getPageTitle(from.pathname, userId);
  if (!label) return null; // not a page we can name (the 404 page)
  const profile = matchPath('/users/:userId', from.pathname)?.params.userId;
  return profile && profile !== userId ? { label, to, ownerId: profile } : { label, to };
};

/**
 * The breadcrumb trail (after Home) for an entry at `pathname` (a page with breadcrumbs, see hasNavTrail),
 * opened from `from` by `navType`. From a page: that page. From another experiment: the page that chain of
 * experiments started on (unless it was Home), then the experiment just left — so the trail stays two
 * steps at most however far the chain goes. Opened directly (`from` null), or reached by Back / Forward
 * without a trail of its own on record: nothing but Home — no page before it that we saw.
 */
export const trailFrom = (
  from: TrailLocation | null,
  navType: NavigationType,
  pathname: string,
  ctx: TrailContext,
): NavCrumb[] => {
  if (!from || navType === NavigationType.Pop) return [];
  const fromTrail = ctx.trailOf(from.key) ?? [];
  // The same experiment or project again, or one swapped in place: the trail it already had.
  if (from.pathname === pathname || (navType === NavigationType.Replace && hasNavTrail(from.pathname))) {
    return fromTrail;
  }
  const fromExperiment = matchPath(ANALYZER_ROUTE, from.pathname)?.params.expId;
  if (!fromExperiment) {
    const crumb = pageCrumb(from, ctx.userId);
    return crumb ? [crumb] : [];
  }
  const origin = fromTrail[0] && !isExperimentPath(fromTrail[0].to) ? [fromTrail[0]] : [];
  return [...origin, { label: ctx.titleOf(fromExperiment) || 'Experiment', to: from.pathname + from.search }];
};
