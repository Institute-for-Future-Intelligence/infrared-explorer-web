import { ProfileLine } from '../types';
import { PRESET_COLORS } from './constants';

// Cap on transects per experiment — one per PRESET_COLORS entry so every line gets a distinct colour.
export const MAX_PROFILE_LINES = 8;

// A transect's colour by its index — shared by the overlay, the manager chips, and the chart series so a
// line looks the same everywhere.
export const profileColor = (i: number) => PRESET_COLORS[i % PRESET_COLORS.length];

const newLineId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `pl-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

// A new transect: a horizontal line across the middle (A left, B right), staggered down the frame by index
// so successive additions don't stack exactly on top of each other. Spread over the full cap (0.15 → 0.85
// for indices 0..MAX_PROFILE_LINES-1) so every default line gets a distinct row. Fractional [0,1] coords.
export const makeProfileLine = (index: number): ProfileLine => {
  const y = 0.15 + (index % MAX_PROFILE_LINES) * 0.1;
  return { id: newLineId(), x1: 0.2, y1: y, x2: 0.8, y2: y };
};

// A transect from hand-drawn endpoints (fractional [0,1], A = press point, B = release point). Name is
// omitted so the overlay falls back to L{n}. Endpoints are taken as given — the caller clamps to the frame
// and enforces the minimum length before adding.
export const makeProfileLineAt = (e: { x1: number; y1: number; x2: number; y2: number }): ProfileLine => ({
  id: newLineId(),
  x1: e.x1,
  y1: e.y1,
  x2: e.x2,
  y2: e.y2,
});

// Sample-count bounds. Enough points to render a smooth curve on a long diagonal, capped so a full-frame
// line stays cheap to recompute every frame.
const MIN_SAMPLES = 16;
const MAX_SAMPLES = 240;

// Keep the line from collapsing to a point (which would make the T(l) axis meaningless). Fractional units.
export const MIN_PROFILE_LENGTH = 0.05;

export interface ProfileSample {
  pos: number; // position along the line, 0 at A → 1 at B
  tempC: number; // temperature in Celsius (nearest-pixel sample)
}

/**
 * Sample the per-pixel temperature grid along the line A→B for one frame. Nearest-neighbour (no
 * bilinear blend) so a reading names a real pixel's temperature, matching the spotmeter / point-probe
 * semantics rather than reporting an interpolated value. Returns Celsius; the chart converts for display.
 *
 * `temps` is a decoded frame's Celsius plane (row-major, idx = y*width + x) — pass getDecodedFrame(buffer).temps
 * so the expensive inflate is shared with the other overlays, not repeated here. A truncated frame's
 * out-of-range pixels read as the format's -273.15 sentinel, exactly as the isotherm/3D consumers see them.
 */
export const sampleLineProfile = (
  temps: Float32Array,
  width: number,
  height: number,
  line: ProfileLine,
  // Force a fixed sample count. The multi-line chart passes one so every transect yields the same number of
  // points at the same normalized positions, letting the series share one X-row set; omit for length-scaled.
  samples?: number,
): ProfileSample[] => {
  const dxFrac = line.x2 - line.x1;
  const dyFrac = line.y2 - line.y1;
  // Point count scales with the line's pixel length (a longer line gets more samples), clamped — unless a
  // fixed count is requested.
  const pixelLength = Math.hypot(dxFrac * width, dyFrac * height);
  const n = samples ?? Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.ceil(pixelLength)));

  const out: ProfileSample[] = new Array(n);
  const maxX = width - 1;
  const maxY = height - 1;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const fx = line.x1 + dxFrac * t;
    const fy = line.y1 + dyFrac * t;
    // Nearest pixel; clamp so an endpoint sitting exactly on the far edge (fraction 1) stays in bounds.
    const px = Math.min(maxX, Math.max(0, Math.floor(fx * width)));
    const py = Math.min(maxY, Math.max(0, Math.floor(fy * height)));
    out[i] = { pos: t, tempC: temps[py * width + px] };
  }
  return out;
};
