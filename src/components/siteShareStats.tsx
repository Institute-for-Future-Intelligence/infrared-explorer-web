import { useEffect, useState } from 'react';
import ShareLinks from '../pages/experimentAnalyzer/infoSection/shareLinks';
import { getSiteStats, SiteStats } from '../services/stats';

/**
 * Top-right corner block for the homepage: social share buttons over a global stats line
 * ("N users created M experiments"). Right-aligned so it tucks into the page corner.
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
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <ShareLinks />
      {stats && (
        <div style={{ fontSize: 13, color: 'var(--ifi-grey)', marginTop: -2 }}>
          {stats.users.toLocaleString()} users created {stats.experiments.toLocaleString()} experiments
        </div>
      )}
    </div>
  );
};

export default SiteShareStats;
