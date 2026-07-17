import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A 2px heat-spectrum bar that sweeps across the top on each route change. The hash router navigates
 * instantly (no data loaders to await), so this is a cosmetic motion cue, not a real progress
 * indicator: every navigation remounts the bar (new key) to replay its one-shot sweep animation.
 */
const TopProgressBar = () => {
  const { pathname } = useLocation();
  const [tick, setTick] = useState(0);
  const first = useRef(true);

  useEffect(() => {
    // Skip the initial mount — only sweep on actual navigations.
    if (first.current) {
      first.current = false;
      return;
    }
    setTick((t) => t + 1);
  }, [pathname]);

  if (tick === 0) return null;
  return <div key={tick} className="route-progress" aria-hidden />;
};

export default TopProgressBar;
