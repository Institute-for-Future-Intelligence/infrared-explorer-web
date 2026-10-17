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
  projectTitleOf: (projectId: string) => string | undefined; // an opened AI Project's title, as its page showed it
  userId?: string; // the signed-in user, to tell "My Profile" from someone else's
};

const pathOf = (to: string) => to.split('?')[0];
const isExperimentPath = (to: string) => !!matchPath(ANALYZER_ROUTE, pathOf(to));
const isProjectPath = (to: string) => !!matchPath(PROJECT_ROUTE, pathOf(to));

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
 * opened from `from` by `navType`. From a page: that page. From an AI Project: the page it was opened from,
 * then the project. From an experiment: the page (and the project) that chain of experiments started on,
 * then the experiment just left — so the trail stays three steps at most however far the chain goes.
 * Back up to one of its own steps (the project over a recording): the trail that step had. Opened directly
 * (`from` null), or reached by Back / Forward without a trail of its own on record: nothing but Home — no
 * page before it that we saw.
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
  // Back up to one of its own steps: the trail that step had.
  const up = fromTrail.findIndex((crumb) => pathOf(crumb.to) === pathname);
  if (up >= 0) return fromTrail.slice(0, up);
  const to = from.pathname + from.search;
  const fromExperiment = matchPath(ANALYZER_ROUTE, from.pathname)?.params.expId;
  if (fromExperiment) {
    const origin = fromTrail.filter((crumb) => !isExperimentPath(crumb.to));
    return [...origin, { label: ctx.titleOf(fromExperiment) || 'Recording', to }];
  }
  const fromProject = matchPath(PROJECT_ROUTE, from.pathname)?.params.projectId;
  if (fromProject) {
    const origin = fromTrail.filter((crumb) => !isExperimentPath(crumb.to) && !isProjectPath(crumb.to));
    return [...origin, { label: ctx.projectTitleOf(fromProject) || 'Experiment', to }];
  }
  const crumb = pageCrumb(from, ctx.userId);
  return crumb ? [crumb] : [];
};
