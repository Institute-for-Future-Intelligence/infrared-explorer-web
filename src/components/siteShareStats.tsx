import { useEffect, useState } from 'react';
import ShareMenu from './shareMenu';
import { SITE_ORIGIN } from '../utils/urls';
import { getSiteStats, SiteStats } from '../services/stats';

/**
 * Top-right corner block for the homepage: a Share button (the site's canonical URL) over a global
 * stats line ("N users created M experiments"). Right-aligned so it tucks into the page corner.
 */
const SiteShareStats = () => {
  const [stats, setStats] = useState<SiteStats | null>(null);

  useEffect(() => {
    // Best-effort: a failed stats fetch just hides the line, the share buttons still render.
    getSiteStats()
      .then(setStats)
      .catch((e) => console.error('failed to load site stats', e));
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', pointerEvents: 'auto' }}>
      <ShareMenu url={SITE_ORIGIN} title="Infrared Explorer" />
      {stats && (
        <div style={{ fontSize: 13, color: 'var(--ifi-grey)', marginTop: -2 }}>
          {stats.users.toLocaleString()} users, {stats.experiments.toLocaleString()} experiments
        </div>
      )}
    </div>
  );
};

export default SiteShareStats;
