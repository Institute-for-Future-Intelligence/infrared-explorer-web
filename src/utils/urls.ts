// Canonical public origin for OUTBOUND links (share buttons, copy-link, QR codes).
//
// The app is reachable on several hosts that do NOT redirect to one another — the canonical
// `ie.intofuture.org`, the legacy `infrared-explorer.intofuture.org`, and the default `*.web.app`.
// So outbound links must never be built from `window.location.origin`: a visitor who arrived on an
// alias would otherwise share that alias, and the non-canonical URL would keep propagating. We pin
// the canonical host in prod; dev falls back to the live origin so localhost / the emulator work.
export const SITE_ORIGIN: string = import.meta.env.PROD ? 'https://ie.intofuture.org' : window.location.origin;

// The app routes on real paths (createBrowserRouter), so share links are simply origin + the in-app
// route. This is also the surface a future OG-meta Function would hang per-experiment link previews
// on (`/experiments/**` rewrite). Older link forms — hash routes (/#/experiments/:id) and Telelab's
// /experiment/:id — stay alive via the permanent normalization shim in index.html.
export const experimentShareUrl = (id: string): string => `${SITE_ORIGIN}/experiments/${id}`;

export const profileShareUrl = (userId: string): string => `${SITE_ORIGIN}/users/${userId}`;

// The current in-app route as a canonical outbound URL — for pages that share "wherever I am now"
// (the homepage share block, an author gallery). `routePath` is the react-router location.pathname,
// e.g. "/users/abc".
export const routeShareUrl = (routePath: string): string => `${SITE_ORIGIN}${routePath}`;

// Infrared Explorer's own policies: static pages in public/, served at these paths by the
// firebase.json rewrites. The same URLs are declared in both app stores and linked from the mobile
// app, so every in-site link points here (never at an in-app route) — one constant, one place to
// change if the pages ever move.
export const TERMS_URL = 'https://ie.intofuture.org/terms';
export const PRIVACY_URL = 'https://ie.intofuture.org/privacy';
