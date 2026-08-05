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

import { memo, useMemo } from 'react';
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

interface Props {
  items: StreetView[];
  /** 'roadmap' | 'satellite' | 'hybrid' */
  mapType: string;
  onSelect: (sv: StreetView) => void;
}

// Memoised: the page re-renders on every viewer open/close/neighbour jump (selected/
// entryAzimuth state), and StreetViewMap's props are referentially stable (items is a
// stable array, mapType a primitive, onSelect a useCallback), so memo() stops all 238
// <Marker> elements being rebuilt (setPosition + click-listener re-register) each time.
const StreetViewMap = memo(function StreetViewMap({ items, mapType, onSelect }: Props) {
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
      options={MAP_OPTIONS}
    >
      {items.length > 0 && (
        <MarkerClusterer>
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
