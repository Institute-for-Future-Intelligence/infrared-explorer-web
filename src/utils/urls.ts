// Canonical public origin for OUTBOUND links (share buttons, copy-link, QR codes).
//
// The app is reachable on several hosts that do NOT redirect to one another — the canonical
// `ie.intofuture.org`, the legacy `infrared-explorer.intofuture.org`, and the default `*.web.app`.
// So outbound links must never be built from `window.location.origin`: a visitor who arrived on an
// alias would otherwise share that alias, and the non-canonical URL would keep propagating. We pin
// the canonical host in prod; dev falls back to the live origin so localhost / the emulator work.
export const SITE_ORIGIN: string = import.meta.env.PROD ? 'https://ie.intofuture.org' : window.location.origin;

// Experiment share links use the legacy PATH form (/experiment/:id), not the in-app hash route
// (/#/experiments/:id). Hosting's `** -> /index.html` rewrite serves the SPA for it and the startup
// shim in index.html rewrites it to the hash route on arrival (the same shim that carries old
// Telelab links). The path form is clean (no '#') and is the surface a future OG-meta Function would
// hang per-experiment link previews on, so links already shared upgrade for free.
export const experimentShareUrl = (id: string): string => `${SITE_ORIGIN}/experiment/${id}`;

// Profiles have no legacy path alias, so they share the in-app hash route directly.
export const profileShareUrl = (userId: string): string => `${SITE_ORIGIN}/#/users/${userId}`;

// The current in-app route as a canonical outbound URL — for pages that share "wherever I am now"
// (the homepage share block, an author gallery). `routePath` is the react-router location.pathname
// (already the in-app path under HashRouter), e.g. "/users/abc".
export const routeShareUrl = (routePath: string): string => `${SITE_ORIGIN}/#${routePath}`;
