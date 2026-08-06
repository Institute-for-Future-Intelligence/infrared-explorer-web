/*
 * StreetViewCompass — the panorama HUD drawn over a street-view frame in the
 * look-around viewer. DOM-SVG port of the app's StreetViewCompassOverlay
 * (react-native-svg → <svg>): a bottom-left compass rose whose needle tracks the
 * current heading, dashed N/E/S/W bearing lines where each cardinal falls within
 * the thermal camera's horizontal FOV, a dotted level/pitch line, the heading
 * read-out, and tappable neighbour markers that jump to adjacent street views.
 *
 * The <svg> is pointer-events:none so it never eats the look-around drag
 * underneath; only the neighbour buttons are interactive.
 */

import { CARDINALS, bearingScreenX, normalizeDeg, pitchScreenY, STREET_VIEW_HFOV } from '../../utils/streetViewPano';
import type { StreetViewNeighbor } from '../../types';

const WHITE = '#ffffff';
const BLACK = '#000000';
const DASH = '8 8';
const NORTH = '#ff5a3c'; // north needle / N label (thermal accent)
const INDEX = '#2bb6b6'; // fixed heading index (teal, app accent)
const GLASS = 'rgba(16,18,22,0.5)';

interface Props {
  width: number;
  height: number;
  /** Current frame's heading (deg, signed), or NaN when unknown. */
  azimuthDeg: number;
  /** Current frame's pitch/elevation (deg), or NaN when unknown. */
  pitchDeg: number;
  neighbors: StreetViewNeighbor[];
  onNeighbor: (svId: string) => void;
  /** Capture time (epoch ms) — appended to the read-out as "azimuth° | date". */
  timestampMs?: number;
  hfov?: number;
}

export default function StreetViewCompass({
  width,
  height,
  azimuthDeg,
  pitchDeg,
  neighbors,
  onNeighbor,
  timestampMs,
  hfov = STREET_VIEW_HFOV,
}: Props) {
  if (width <= 0 || height <= 0 || Number.isNaN(azimuthDeg)) return null;

  const dateText =
    timestampMs != null && Number.isFinite(timestampMs)
      ? new Date(timestampMs).toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;
  const readout = `${normalizeDeg(azimuthDeg).toFixed(0)}°${dateText ? `  ·  ${dateText}` : ''}`;

  // Compass geometry (bottom-left) — kept compact so it doesn't dominate the
  // full-screen panorama.
  const r = Math.max(22, Math.min(34, Math.min(width, height) * 0.055));
  const cx = r + 14;
  const cy = height - r - 14;
  const azRad = (azimuthDeg * Math.PI) / 180;
  // Screen position of the (upright) North label as the dial rotates by −azimuth.
  const nRad = r * 0.86;
  const nx = cx - nRad * Math.sin(azRad);
  const ny = cy - nRad * Math.cos(azRad);
  const ticks = [0, 45, 90, 135, 180, 225, 270, 315];

  const yPitch = pitchScreenY(pitchDeg, height);

  const neighborMarkers = neighbors
    .map((n) => ({ n, x: bearingScreenX(n.azimuthDeg, azimuthDeg, width, hfov) }))
    .filter((m): m is { n: StreetViewNeighbor; x: number } => m.x != null);

  return (
    <div className="sv-compass" style={{ width, height }}>
      <svg width={width} height={height} className="sv-compass-svg">
        {/* N/E/S/W bearing lines + labels within the FOV. */}
        {CARDINALS.map((c) => {
          const x = bearingScreenX(c.bearing, azimuthDeg, width, hfov);
          if (x == null) return null;
          return (
            <g key={c.label}>
              <line
                x1={x}
                y1={0}
                x2={x}
                y2={height}
                stroke={WHITE}
                strokeWidth={2}
                strokeDasharray={DASH}
                opacity={0.8}
              />
              <text
                x={x}
                y={26}
                fill={WHITE}
                fontSize={13}
                fontWeight="600"
                letterSpacing="1"
                textAnchor="middle"
                stroke={BLACK}
                strokeWidth={0.4}
              >
                {c.label}
              </text>
            </g>
          );
        })}

        {/* Level / pitch line. */}
        {yPitch != null && (
          <line
            x1={0}
            y1={yPitch}
            x2={width}
            y2={yPitch}
            stroke={WHITE}
            strokeWidth={2}
            strokeDasharray={DASH}
            opacity={0.65}
          />
        )}

        {/* Compass — a glass disc with a fixed teal heading index at the top (the way
            you're facing), a dial + red North needle that rotate with the heading, and
            an upright "N" riding the dial's north point. */}
        <circle cx={cx} cy={cy} r={r} fill={GLASS} stroke="rgba(255,255,255,0.3)" strokeWidth={1.25} />
        {/* fixed heading index: a small triangle biting into the top of the ring */}
        <path d={`M ${cx} ${cy - r + 6} L ${cx - 4.5} ${cy - r - 3.5} L ${cx + 4.5} ${cy - r - 3.5} Z`} fill={INDEX} />
        <g transform={`rotate(${-azimuthDeg} ${cx} ${cy})`}>
          {ticks.map((a) => {
            const rad = (a * Math.PI) / 180;
            const inner = a % 90 === 0 ? r * 0.66 : r * 0.8;
            return (
              <line
                key={a}
                x1={cx + inner * Math.sin(rad)}
                y1={cy - inner * Math.cos(rad)}
                x2={cx + r * 0.9 * Math.sin(rad)}
                y2={cy - r * 0.9 * Math.cos(rad)}
                stroke="rgba(255,255,255,0.4)"
                strokeWidth={a % 90 === 0 ? 1.4 : 0.8}
              />
            );
          })}
          <path d={`M ${cx} ${cy - r * 0.62} L ${cx - r * 0.14} ${cy} L ${cx + r * 0.14} ${cy} Z`} fill={NORTH} />
          <path
            d={`M ${cx} ${cy + r * 0.62} L ${cx - r * 0.14} ${cy} L ${cx + r * 0.14} ${cy} Z`}
            fill="rgba(236,238,242,0.9)"
          />
          <circle cx={cx} cy={cy} r={2.3} fill={WHITE} />
        </g>
        {/* upright North letter riding the dial's north point */}
        <text
          x={nx}
          y={ny}
          fill={NORTH}
          fontSize={Math.max(9, r * 0.36)}
          fontWeight="700"
          textAnchor="middle"
          dominantBaseline="central"
        >
          N
        </text>
      </svg>

      {/* "azimuth° · date" read-out (bottom-right) — an HTML pill that hugs its text
          (no SVG width estimation, so no empty box). */}
      <div className="sv-readout">{readout}</div>

      {/* Tappable neighbour markers (the only interactive layer). */}
      {neighborMarkers.map(({ n, x }) => (
        <button
          key={n.svId}
          type="button"
          className="sv-neighbor"
          title="Go to adjacent street view"
          onClick={() => onNeighbor(n.svId)}
          style={{ left: x - 40, top: height * 0.6 - 14 }}
        >
          <span className="sv-neighbor-arrow" />
        </button>
      ))}
    </div>
  );
}
