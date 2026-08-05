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
const GRAY = '#c8c8c8';
const DASH = '10 10';

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
  const readout = `${normalizeDeg(azimuthDeg).toFixed(2)}°${dateText ? ` | ${dateText}` : ''}`;

  // Compass rose geometry (bottom-left).
  const r = Math.max(44, Math.min(80, Math.min(width, height) * 0.14));
  const cx = r + 16;
  const cy = height - r - 16;
  const tick = r * 0.14;
  const cos45 = Math.cos(Math.PI / 4);

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
              <line x1={x} y1={0} x2={x} y2={height} stroke={WHITE} strokeWidth={4} strokeDasharray={DASH} />
              <text
                x={x}
                y={28}
                fill={WHITE}
                fontSize={18}
                fontWeight="bold"
                textAnchor="middle"
                stroke={BLACK}
                strokeWidth={0.5}
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
            strokeWidth={3}
            strokeDasharray={DASH}
            opacity={0.85}
          />
        )}

        {/* Compass rose: ring + cardinal/inter-cardinal ticks + heading needle. */}
        <circle cx={cx} cy={cy} r={r} fill="rgba(0,0,0,0.45)" />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={GRAY} strokeWidth={4} />
        <line x1={cx} y1={cy - r} x2={cx} y2={cy - r + tick} stroke={GRAY} strokeWidth={2} />
        <line x1={cx} y1={cy + r} x2={cx} y2={cy + r - tick} stroke={GRAY} strokeWidth={2} />
        <line x1={cx - r} y1={cy} x2={cx - r + tick} y2={cy} stroke={GRAY} strokeWidth={2} />
        <line x1={cx + r} y1={cy} x2={cx + r - tick} y2={cy} stroke={GRAY} strokeWidth={2} />
        <line
          x1={cx - r * cos45}
          y1={cy - r * cos45}
          x2={cx - (r - tick) * cos45}
          y2={cy - (r - tick) * cos45}
          stroke={GRAY}
          strokeWidth={2}
        />
        <line
          x1={cx + r * cos45}
          y1={cy + r * cos45}
          x2={cx + (r - tick) * cos45}
          y2={cy + (r - tick) * cos45}
          stroke={GRAY}
          strokeWidth={2}
        />
        <line
          x1={cx - r * cos45}
          y1={cy + r * cos45}
          x2={cx - (r - tick) * cos45}
          y2={cy + (r - tick) * cos45}
          stroke={GRAY}
          strokeWidth={2}
        />
        <line
          x1={cx + r * cos45}
          y1={cy - r * cos45}
          x2={cx + (r - tick) * cos45}
          y2={cy - (r - tick) * cos45}
          stroke={GRAY}
          strokeWidth={2}
        />
        {/* Needle: red arm points to the heading, white arm opposite. */}
        <g transform={`rotate(${azimuthDeg} ${cx} ${cy})`}>
          <path d={`M ${cx} ${cy - r + 20} L ${cx - 20} ${cy} L ${cx + 20} ${cy} Z`} fill="#E53935" />
          <path d={`M ${cx} ${cy + r - 20} L ${cx - 20} ${cy} L ${cx + 20} ${cy} Z`} fill={WHITE} />
        </g>

        {/* "azimuth° | date" read-out (bottom-right). */}
        <text
          x={width - 16}
          y={height - 18}
          fill={WHITE}
          fontSize={15}
          fontWeight="600"
          textAnchor="end"
          stroke={BLACK}
          strokeWidth={0.5}
        >
          {readout}
        </text>
      </svg>

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
