import { CSSProperties, useMemo } from 'react';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { temp01ToCss } from '../../../utils/colormap';
import { normalizePaletteName, paletteGradientCss } from '../../../utils/palette';
import useCommonStore from '../../../stores/common';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';

interface Props {
  buffer?: ArrayBuffer;
  // The two overlays are independent toolbar toggles; the host mounts this component when EITHER is on.
  showBar?: boolean;
  showMarkers?: boolean;
  // The resolved FLIR palette key of the baked frames (see utils/palette). When known, the bar draws that
  // exact ramp so its colours line up with the image; when null/unknown it falls back to the approximate
  // HSL ramp below and flags the strip "approx.".
  paletteName?: string | null;
}

const GRADIENT_STOPS = 12;
// Fallback ramp when the experiment's real FLIR palette isn't known (see utils/palette). Blue→red HSL
// (hue 240→0, the app's own 3D-surface / isotherm-legend ramp) — a rough stand-in that roughly tracks the
// common rainbow palette but does NOT match iron / lava / etc. Left (cold, t=0) → right (hot, t=1).
const HSL_FALLBACK_GRADIENT = `linear-gradient(to right, ${Array.from({ length: GRADIENT_STOPS + 1 }, (_, i) =>
  temp01ToCss(i / GRADIENT_STOPS),
).join(', ')})`;

const pill: CSSProperties = {
  background: 'rgba(0,0,0,0.55)',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
};

/**
 * The current frame's temperature scale bar (top) plus markers on its hottest and coldest pixels. The
 * capture app auto-gains each frame — its coldest→hottest pixel spans the baked FLIR palette — so a bar
 * labelled with THIS frame's min/max, drawn in that same palette (when `paletteName` is known; otherwise an
 * approximate ramp flagged "approx."), lines up with the colours on the image. Marker positions come from
 * the decoded frame's argmin/argmax (row-major idx → pixel centre), the same grid the isotherm overlay
 * draws on, so a marker sits on the pixel it names. The temperature LABELS are always exact (read off the
 * .dat) regardless of palette. Captured in screenshots (like the isotherms) — a plain overlay, no ignore.
 */
const ScaleHotspots = ({ buffer, showBar, showMarkers, paletteName }: Props) => {
  const unit = useCommonStore((s) => s.temperatureUnit);
  // Draw the experiment's real palette LUT when we know it; otherwise the approximate HSL ramp, flagged.
  const paletteKey = normalizePaletteName(paletteName);
  const barGradient = (paletteKey && paletteGradientCss(paletteKey)) || HSL_FALLBACK_GRADIENT;
  const approxColours = !paletteKey;
  const frame = useMemo(() => {
    if (!buffer) return null;
    try {
      const { min, max, minIdx, maxIdx, width, height, complete } = getDecodedFrame(buffer);
      // A truncated frame fills its missing pixels with the -273.15 sentinel (thermalFrame flags it
      // `complete=false`), which would poison the min label / midpoint and plant the cold marker on the
      // first corrupt pixel — so skip it, the same way the thumbnail path does.
      if (!complete || !isFinite(min) || !isFinite(max)) return null;
      const at = (idx: number) => ({
        x: ((idx % width) + 0.5) / width,
        y: (Math.floor(idx / width) + 0.5) / height,
      });
      return { min, max, hot: at(maxIdx), cold: at(minIdx) };
    } catch (e) {
      console.error('failed to decode frame for scale/hotspots', e);
      return null;
    }
  }, [buffer]);

  if (!frame) return null;
  const sym = temperatureSymbol(unit);
  const dMin = displayTemp(frame.min, unit);
  const dMax = displayTemp(frame.max, unit);
  const dMid = (dMin + dMax) / 2;

  const marker = (pos: { x: number; y: number }, color: string, label: string, value: number) => {
    const flipX = pos.x > 0.78; // put the label on the inner side near the right edge
    return (
      <div
        style={{
          position: 'absolute',
          left: `${pos.x * 100}%`,
          top: `${pos.y * 100}%`,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: `2px solid ${color}`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.65)',
          }}
        />
        <span
          style={{
            position: 'absolute',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 10,
            color: '#fff',
            ...pill,
            ...(flipX ? { right: 12 } : { left: 12 }),
          }}
        >
          {label} {value.toFixed(1)} {sym}
        </span>
      </div>
    );
  };

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {showBar && (
        // Horizontal scale bar, spanning the top edge (the isotherm legend now sits bottom-right).
        <div
          style={{ position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 3 }}
        >
          <div
            style={{
              position: 'relative',
              height: 10,
              borderRadius: 2,
              background: barGradient,
              boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
            }}
          >
            {/* Colours are a guess when the real FLIR palette isn't known — the temperature labels stay
                exact (they read off the .dat), only the ramp hues are approximate. */}
            {approxColours && (
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 8,
                  fontStyle: 'italic',
                  letterSpacing: 0.5,
                  color: 'rgba(255,255,255,0.9)',
                  textShadow: '0 0 2px rgba(0,0,0,0.9)',
                }}
              >
                approx.
              </span>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#fff' }}>
            <span style={pill}>
              {dMin.toFixed(1)} {sym}
            </span>
            <span style={pill}>{dMid.toFixed(1)}</span>
            <span style={pill}>
              {dMax.toFixed(1)} {sym}
            </span>
          </div>
        </div>
      )}

      {showMarkers && (
        <>
          {marker(frame.hot, '#ff453a', 'max', dMax)}
          {marker(frame.cold, '#0a84ff', 'min', dMin)}
        </>
      )}
    </div>
  );
};

export default ScaleHotspots;
