/*
 * A shared project's link (docs/proposals/lab-project-sharing.md §3.1, §3.5):
 * https://ie.intofuture.org/projects/<id>?k=<token> — the website's path,
 * which both platforms register as a deep link — and the same path under the
 * app's own scheme, which the website's "Open in App" button uses. Pure, so
 * the suite runs it in bare Node.
 */

/** The website, whose /projects/<id> path the app registers as a deep link. */
export const WEB_ORIGIN = 'https://ie.intofuture.org';
/** The app's own scheme, for the website's "Open in App" button. */
export const APP_SCHEME = 'infraredexplorer';

export interface ProjectLink {
  projectId: string;
  /** The link's `k`; null on a public project's bare link. */
  token: string | null;
}

const LINK =
  /^(?:https?:\/\/ie\.intofuture\.org|infraredexplorer:\/)\/projects\/([A-Za-z0-9_-]{1,128})\/?(?:\?([^#]*))?(?:#.*)?$/;

/**
 * The project a link names, or null for anything else. A `k` that is not a
 * token (the wrong shape) is dropped, not passed along: the server would
 * refuse it anyway, and a public project opens without one.
 */
export function parseProjectLink(url: string | null | undefined): ProjectLink | null {
  if (!url) {
    return null;
  }
  const m = LINK.exec(url.trim());
  if (!m) {
    return null;
  }
  let token: string | null = null;
  for (const pair of (m[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key === 'k') {
      let v = '';
      try {
        v = decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1));
      } catch {
        v = '';
      }
      token = /^[A-Za-z0-9]{8,128}$/.test(v) ? v : null;
    }
  }
  return {projectId: m[1], token};
}

export function projectLinkUrl(projectId: string, token: string | null): string {
  const base = `${WEB_ORIGIN}/projects/${encodeURIComponent(projectId)}`;
  return token ? `${base}?k=${token}` : base;
}
