import { matchPath } from 'react-router-dom';

// What each page is called: the title centred in the header (Home shows the search box instead), and the
// name a page goes by in the breadcrumbs once you've left it for an experiment or an AI Project. Labels
// match the sidebar nav; dynamic routes are matched by pattern. `ownHeading`: the page heads itself, so
// the header leaves its centre empty there and the name only serves the breadcrumbs.
const PAGE_TITLES: { pattern: string; title: string; ownHeading?: boolean }[] = [
  { pattern: '/community', title: 'Community' },
  { pattern: '/streetview', title: 'Street View' },
  { pattern: '/me', title: 'Me' },
  { pattern: '/myExperimentsList', title: 'My Experiments' },
  // The project list carries its own "My Projects" heading, beside New Project.
  { pattern: '/projects', title: 'My Projects', ownHeading: true },
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
  { pattern: '/admin/streetview-reports', title: 'Street View Reports' },
  { pattern: '/experiments/:expId', title: 'Experiment Analyzer' },
  { pattern: '/users/:userId', title: 'User Profile' },
  { pattern: '/showcase/authors/:author', title: 'Showcase Author' },
];

const findPage = (pathname: string) => PAGE_TITLES.find((p) => matchPath(p.pattern, pathname));

// The profile route is shared between "my own profile" and "someone else's"; title it accordingly so
// the header reflects which one you're looking at.
export const getPageTitle = (pathname: string, currentUserId?: string): string | undefined => {
  const ownProfile = matchPath('/users/:userId', pathname);
  if (ownProfile && currentUserId && ownProfile.params.userId === currentUserId) return 'My Profile';
  return findPage(pathname)?.title;
};

/** The title the header centres: the page's name, unless the page heads itself (`ownHeading`). */
export const getHeaderTitle = (pathname: string, currentUserId?: string): string | undefined =>
  findPage(pathname)?.ownHeading ? undefined : getPageTitle(pathname, currentUserId);
