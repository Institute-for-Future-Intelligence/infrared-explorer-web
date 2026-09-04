/*
 * Google Maps browser for public street views — the web counterpart of the app's
 * MapLibre StreetViewMapScreen, built on @react-google-maps/api (the same stack as
 * aladdin2's Models Map: GoogleMap + MarkerClusterer). Native mapTypeId gives the
 * roadmap/satellite/hybrid three-state for free. ★ markers cluster client-side;
 * a click hands the StreetView up to the page, which opens the viewer.
 *
 * Deliberately does NOT auto-fit the markers: the legacy dataset spans two
 * continents, so framing them yanks the camera off the default view. Opens on
 * Boston downtown (legacy VideoStreetActivity default) and stays put until panned.
 */

import { memo, useCallback, useMemo } from 'react';
import { GoogleMap, Marker, MarkerClusterer, useJsApiLoader } from '@react-google-maps/api';
import { Spin } from 'antd';
import type { StreetView } from '../../types';

const MAPS_API_KEY = import.meta.env.VITE_MAPS_API_KEY as string | undefined;

// Boston downtown — the legacy default center (app assets/html/streetViewMapHtml.ts).
const DEFAULT_CENTER = { lat: 42.3651835, lng: -71.07414 };
const DEFAULT_ZOOM = 12;
const CONTAINER_STYLE = { width: '100%', height: '100%' } as const;

// Gold ★ with a dark outline (echoes the app's .sv-marker glyph), as a data-URI so
// no google.maps.* symbol needs constructing before the API loads.
const STAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24">' +
  '<path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 7.1-1.01L12 2z" ' +
  'fill="#FFD54A" stroke="#5a4a00" stroke-width="1" stroke-linejoin="round"/></svg>';
const STAR_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STAR_SVG)}`;

const MAP_OPTIONS: google.maps.MapOptions = {
  streetViewControl: false,
  mapTypeControl: false, // driven by our own Segmented toggle in the page
  fullscreenControl: false,
  clickableIcons: false,
  gestureHandling: 'greedy',
};

// "Labels off" = streets only: blank every label layer (place names, POI pins, transit
// glyphs, route shields), then re-enable road-name text so the map still orients the
// user. Rules apply in order, later/more-specific wins. Inline `styles` restyle
// roadmap geometry+labels and hybrid's label overlay alike (satellite has no labels to
// begin with), so this covers all three map types. Only honoured without a cloud
// mapId, which we don't set.
const HIDE_LABELS_STYLES: google.maps.MapTypeStyle[] = [
  { featureType: 'all', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels.text', stylers: [{ visibility: 'on' }] },
];

/*
 * Cluster click zoom. The library's built-in handler runs
 * `map.fitBounds(cluster.getBounds())`, and that getBounds() is NOT the members'
 * extent — Cluster.calculateBounds() builds a box around the cluster centre padded
 * by gridSize (60px) on each side. Blowing a 120px box up to fill the viewport
 * zooms ~3 levels per click no matter how the members are really spread, which is
 * how one click on a pair of street views 20 m apart lands you on the rooftops.
 *
 * So: turn the built-in handler off and step in gently instead, capped. The cap and
 * the clustering cutoff are deliberately paired — above CLUSTER_STOP_ZOOM no cluster
 * icon is drawn at all, so a click always dissolves the cluster it landed on and can
 * never be a dead end.
 */
const CLUSTER_STOP_ZOOM = 17; // highest zoom that still clusters; above it every ★ stands alone
const CLUSTER_CLICK_MAX_ZOOM = CLUSTER_STOP_ZOOM + 1;
const CLUSTER_CLICK_ZOOM_STEP = 2;

const CLUSTERER_OPTIONS = {
  zoomOnClick: false, // replaced by onClusterClick below
  maxZoom: CLUSTER_STOP_ZOOM,
};

/**
 * The slice of the clusterer's `Cluster` we actually touch. Its real type lives in
 * @react-google-maps/marker-clusterer, a transitive dep that @react-google-maps/api
 * does not re-export, so declare the shape rather than import across the boundary.
 */
interface ClusterLike {
  getCenter: () => google.maps.LatLng | undefined;
  getMap: () => google.maps.Map | google.maps.StreetViewPanorama | null;
}

interface Props {
  items: StreetView[];
  /** 'roadmap' | 'satellite' | 'hybrid' */
  mapType: string;
  /** false → only street names remain (see HIDE_LABELS_STYLES) */
  showLabels: boolean;
  onSelect: (sv: StreetView) => void;
}

// Memoised: the page re-renders on every viewer open/close/neighbour jump (selected/
// entryAzimuth state), and StreetViewMap's props are referentially stable (items is a
// stable array, mapType/showLabels primitives, onSelect a useCallback), so memo() stops
// all 238 <Marker> elements being rebuilt (setPosition + click-listener re-register) each time.
const StreetViewMap = memo(function StreetViewMap({ items, mapType, showLabels, onSelect }: Props) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: MAPS_API_KEY ?? '',
  });

  // Center the star on its coordinate (default marker anchoring is bottom-center).
  // google.maps.* only exists once the API is loaded, so gate the construction.
  const starIcon = useMemo<google.maps.Icon | undefined>(
    () =>
      isLoaded
        ? {
            url: STAR_URL,
            scaledSize: new google.maps.Size(28, 28),
            anchor: new google.maps.Point(14, 14),
          }
        : undefined,
    [isLoaded],
  );

  // Step in toward the cluster instead of the library's ~3-level fitBounds jump.
  // `panTo` after `setZoom` so the centring is the last camera command to land.
  const onClusterClick = useCallback((cluster: ClusterLike) => {
    const map = cluster.getMap();
    // A StreetViewPanorama also answers getZoom/setZoom but cannot pan; narrow to Map.
    if (!map || !('panTo' in map)) return;
    const current = map.getZoom() ?? DEFAULT_ZOOM;
    const next = Math.min(current + CLUSTER_CLICK_ZOOM_STEP, CLUSTER_CLICK_MAX_ZOOM);
    if (next > current) map.setZoom(next);
    const center = cluster.getCenter();
    if (center) map.panTo(center);
  }, []);

  // GoogleMap re-applies setOptions() whenever the options object's identity changes,
  // so build it once per showLabels flip rather than fresh on every render. `null`
  // (not undefined) is what actually clears a previously applied style set.
  const options = useMemo<google.maps.MapOptions>(
    () => ({ ...MAP_OPTIONS, styles: showLabels ? null : HIDE_LABELS_STYLES }),
    [showLabels],
  );

  if (loadError) {
    return (
      <div className="streetview-map-msg">
        地图加载失败。请检查网络,以及该 Maps API key 的 referrer 白名单是否包含本域名。
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div className="streetview-map-loading">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <GoogleMap
      mapContainerStyle={CONTAINER_STYLE}
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      mapTypeId={mapType}
      options={options}
    >
      {items.length > 0 && (
        <MarkerClusterer options={CLUSTERER_OPTIONS} onClick={onClusterClick}>
          {(clusterer) => (
            <>
              {items.map((sv) => (
                <Marker
                  key={sv.svId}
                  position={{ lat: sv.lat, lng: sv.lng }}
                  title={sv.title}
                  icon={starIcon}
                  clusterer={clusterer}
                  onClick={() => onSelect(sv)}
                />
              ))}
            </>
          )}
        </MarkerClusterer>
      )}
    </GoogleMap>
  );
});

export default StreetViewMap;
