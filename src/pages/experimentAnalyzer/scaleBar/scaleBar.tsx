import { CSSProperties, useMemo } from 'react';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { temp01ToCss } from '../../../utils/colormap';
import { normalizePaletteName, paletteGradientCss } from '../../../utils/palette';
import useCommonStore from '../../../stores/common';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';

interface Props {
  buffer?: ArrayBuffer;
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
 * The current frame's temperature scale bar, along the top edge of the image. The capture app auto-gains
 * each frame — its coldest→hottest pixel spans the baked FLIR palette — so a bar labelled with THIS
 * frame's min/max, drawn in that same palette (when `paletteName` is known; otherwise an approximate ramp
 * flagged "approx."), lines up with the colours on the image. The temperature LABELS are always exact
 * (read off the .dat) regardless of palette. Captured in screenshots (like the isotherms) — a plain
 * overlay, no ignore.
 */
const ScaleBar = ({ buffer, paletteName }: Props) => {
  const unit = useCommonStore((s) => s.temperatureUnit);
  // Draw the experiment's real palette LUT when we know it; otherwise the approximate HSL ramp, flagged.
  const paletteKey = normalizePaletteName(paletteName);
  const barGradient = (paletteKey && paletteGradientCss(paletteKey)) || HSL_FALLBACK_GRADIENT;
  const approxColours = !paletteKey;
  const range = useMemo(() => {
    if (!buffer) return null;
    try {
      const { min, max, complete } = getDecodedFrame(buffer);
      // A truncated frame fills its missing pixels with the -273.15 sentinel (thermalFrame flags it
      // `complete=false`), which would poison the min label / midpoint — so skip it, the same way the
      // thumbnail path does.
      if (!complete || !isFinite(min) || !isFinite(max)) return null;
      return { min, max };
    } catch (e) {
      console.error('failed to decode frame for the scale bar', e);
      return null;
    }
  }, [buffer]);

  if (!range) return null;
  const sym = temperatureSymbol(unit);
  const dMin = displayTemp(range.min, unit);
  const dMax = displayTemp(range.max, unit);
  const dMid = (dMin + dMax) / 2;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* Horizontal scale bar, spanning the top edge (the isotherm legend sits bottom-right). */}
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
    </div>
  );
};

export default ScaleBar;
