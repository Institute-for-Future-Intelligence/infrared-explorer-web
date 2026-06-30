import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';

// All keys live under one namespace so the list-page preferences are easy to spot (and clear) in
// devtools, and never collide with other localStorage entries (e.g. the cookie-consent flag).
const PREFIX = 'ie.list.';

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Unreadable / malformed entry, or storage blocked (private mode) — fall back to the default.
    return fallback;
  }
};

/**
 * `useState` whose value is mirrored to `localStorage` under `ie.list.<key>`, so a list page's
 * sort/filter selection survives navigating away (which unmounts the page) and full reloads. Same
 * signature as `useState`; the stored JSON is read once on mount and rewritten on every change.
 *
 * The default is only persisted once the user actually changes the value — until then nothing is
 * written, so a returning user who never touched the control still picks up any later change to the
 * default rather than being pinned to a stale one.
 */
export function usePersistentState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial));

  // Skip the write on the initial render so we don't immediately echo back the value we just read.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage full or blocked — persistence is best-effort, so a failed write is non-fatal.
    }
  }, [key, value]);

  return [value, setValue];
}
