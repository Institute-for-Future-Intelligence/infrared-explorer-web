import { useEffect, useState } from 'react';

// Shared responsive breakpoints. Keep in sync with the @media rules in App.css:
//   MOBILE  (<=768px): tablet/phone behaviours — the sidebar becomes an off-canvas drawer, the
//                      analyzer stacks vertically, toolbars wrap, etc.
//   PHONE   (<=480px): phone-only tweaks layered on top of the mobile rules.
export const MOBILE_BREAKPOINT = 768;
export const PHONE_BREAKPOINT = 480;

/**
 * Reactive media-query match. Returns true while the viewport is at or below `maxWidth`, updating on
 * resize / orientation change. SSR-safe (defaults to false when `window` is absent).
 */
export const useMediaMaxWidth = (maxWidth: number): boolean => {
  const query = `(max-width: ${maxWidth}px)`;
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync once in case the viewport changed between render and effect.
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
};

/** True on tablet/phone widths (<=768px) — the breakpoint at which the layout switches to mobile. */
export const useIsMobile = () => useMediaMaxWidth(MOBILE_BREAKPOINT);

/** True on phone widths (<=480px) — for the tighter phone-only adjustments. */
export const useIsPhone = () => useMediaMaxWidth(PHONE_BREAKPOINT);
