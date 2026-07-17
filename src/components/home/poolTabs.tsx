export type HomePool = 'showcase' | 'community';

const SUBTITLE: Record<HomePool, string> = {
  showcase: 'Hand-picked by the IFI team',
  community: 'The latest from all explorers — newest first',
};

/**
 * Segmented control that splits the bottom grid into two pools:
 *  - Showcase  — the staff-curated set (`featured`), the same pool the hero + rows slice from;
 *  - Community — every explorer's public experiments, newest first.
 * A one-line subtitle names who chose the current pool, so teachers can tell curated content from
 * open user uploads at a glance.
 */
const PoolTabs = ({ pool, onChange }: { pool: HomePool; onChange: (p: HomePool) => void }) => (
  <div className="pool-section-head">
    <div className="pool-tabs" role="tablist" aria-label="Experiment pools">
      {(['showcase', 'community'] as HomePool[]).map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          className="pool-tab"
          aria-selected={pool === p}
          onClick={() => onChange(p)}
        >
          {p === 'showcase' ? 'Showcase' : 'Community'}
        </button>
      ))}
    </div>
    <p className="pool-sub">{SUBTITLE[pool]}</p>
  </div>
);

export default PoolTabs;
