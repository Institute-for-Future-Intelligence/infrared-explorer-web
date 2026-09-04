/*
 * Street View (/streetview) — a public map of geo-tagged thermal panoramas (the
 * viewer side of the app's Infrared Street View). The map (Google Maps, lazy-
 * loaded) plots every public `streetviews` doc as a ★; clicking one opens the
 * look-around viewer. Capture/upload stays in the mobile app. Neighbour jumps are
 * resolved against the already-loaded set (no extra fetch — the whole public set,
 * ~238 docs, loads up front). See docs/street-view-web-plan.md.
 */

import { lazy, Suspense, useCallback, useState } from 'react';
import { Segmented, Spin, Switch } from 'antd';
import EmptyState from '../../components/emptyState';
import { useStreetViews } from '../../hooks/useStreetViews';
import { usePersistentState } from '../../hooks/usePersistentState';
import StreetViewViewer from './streetViewViewer';
import type { StreetView as StreetViewType } from '../../types';

const StreetViewMap = lazy(() => import('./streetViewMap'));
const MAPS_API_KEY = import.meta.env.VITE_MAPS_API_KEY as string | undefined;

const MAP_TYPE_OPTIONS = [
  { label: 'Map', value: 'roadmap' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
];

export default function StreetView() {
  const { items, loading, error, retry } = useStreetViews(true);
  const [mapType, setMapType] = usePersistentState<string>('streetview.mapType', 'roadmap');
  // Map labels off by default: Google's POI/place clutter buries our ★ markers, and
  // they're the only payload. "Off" still keeps street names for orientation. Satellite
  // has no labels, so the switch is moot there (disabled; the preference is kept).
  const [showLabels, setShowLabels] = usePersistentState<boolean>('streetview.labels', false);
  const labelsMoot = mapType === 'satellite';
  const [selected, setSelected] = useState<StreetViewType | null>(null);
  const [entryAzimuth, setEntryAzimuth] = useState<number | undefined>(undefined);

  const openMarker = useCallback((sv: StreetViewType) => {
    setEntryAzimuth(undefined);
    setSelected(sv);
  }, []);

  // Neighbour jump: swap to the adjacent doc from the loaded set, facing the way we left.
  const openNeighbor = useCallback(
    (svId: string, fromAzimuth: number) => {
      const next = items.find((i) => i.svId === svId);
      if (next) {
        setEntryAzimuth(Number.isFinite(fromAzimuth) ? fromAzimuth : undefined);
        setSelected(next);
      }
    },
    [items],
  );

  if (!MAPS_API_KEY) {
    return (
      <div className="streetview-page">
        <EmptyState title="Map unavailable" hint="VITE_MAPS_API_KEY is not configured for this build." />
      </div>
    );
  }

  return (
    <div className="streetview-page">
      <div className="streetview-map-wrap">
        <Suspense
          fallback={
            <div className="streetview-map-loading">
              <Spin size="large" />
            </div>
          }
        >
          <StreetViewMap items={items} mapType={mapType} showLabels={showLabels} onSelect={openMarker} />
        </Suspense>

        <div className="streetview-controls">
          <Segmented
            size="small"
            value={mapType}
            onChange={(v) => setMapType(v as string)}
            options={MAP_TYPE_OPTIONS}
          />
          <label
            className={`streetview-labels-toggle${labelsMoot ? ' is-moot' : ''}`}
            title={
              labelsMoot ? 'Satellite imagery has no labels' : 'Show place & business labels (street names always stay)'
            }
          >
            <Switch
              size="small"
              checked={showLabels}
              disabled={labelsMoot}
              onChange={(checked) => setShowLabels(checked)}
            />
            Labels
          </label>
        </div>

        <div
          className={`streetview-badge${error ? ' streetview-badge-error' : ''}`}
          onClick={error ? retry : undefined}
          role={error ? 'button' : undefined}
        >
          {error
            ? "Couldn't load — tap to retry"
            : loading
              ? 'Loading street views…'
              : `${items.length} street view${items.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {selected && (
        <StreetViewViewer
          key={selected.svId}
          sv={selected}
          initialAzimuth={entryAzimuth}
          onClose={() => setSelected(null)}
          onNeighbor={openNeighbor}
        />
      )}
    </div>
  );
}
