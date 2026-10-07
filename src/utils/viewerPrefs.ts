// Display preferences kept in THIS browser (localStorage) for whoever is looking — signed in or not, owner
// or not: they're how this viewer likes to look at things (where the 3D miniplayer sits; the °C/°F an
// experiment saved without a unit opens in), not part of an experiment, so they're never written to an
// experiment doc. (What the owner sets up for everyone — the isotherms, scale bar, charts, the image view,
// and where they left the playhead, the 3D surface and the unit — is saved on the experiment instead; see
// useAnalysisPersistence and useSavedViewWriter.) All keys share one namespace so they're easy to spot and
// clear in devtools, apart from the list pages' `ie.list.*`.
const PREFIX = 'ie.view.';

/** The stored value, or `fallback` when there's none, it's unreadable, or storage is blocked. */
export const readViewerPref = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

/** Store a value (`undefined` removes the key). Best-effort: a full or blocked storage is ignored. */
export const writeViewerPref = (key: string, value: unknown) => {
  try {
    if (value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode) — the preference just won't outlive the page.
  }
};
