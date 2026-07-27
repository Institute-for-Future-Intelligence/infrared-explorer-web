import { useEffect, useMemo, useRef } from 'react';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import { delta01ToRgb, deltaToCss } from '../../../utils/colormap';
import useCommonStore from '../../../stores/common';
import { displayTempDelta, temperatureSymbol } from '../../../utils/helpers';

interface Props {
  buffer?: ArrayBuffer; // current frame's thermal data
  refBuffer?: ArrayBuffer; // reference frame's thermal data (the frame we subtract)
  // Human label for the reference frame (e.g. "0:00"), shown in the legend so the comparison is clear.
  refLabel?: string;
  // Make the displayed frame the new Δ reference (mirrors the right-click menu). Shown as a legend button.
  onSetReference?: () => void;
}

const GRADIENT_STEPS = 12;
const DIFF_GRADIENT = `linear-gradient(to right, ${Array.from({ length: GRADIENT_STEPS + 1 }, (_, i) =>
  deltaToCss((i / GRADIENT_STEPS) * 2 - 1),
).join(', ')})`;

/**
 * Frame-difference (ΔT) overlay: paints (current frame − reference frame) per-pixel temperature as a
 * diverging blue→white→red image, so heating (red) and cooling (blue) relative to the reference stand out
 * — e.g. what warmed up since t=0. Both frames are decoded client-side from the .dat/.vir (no cross-origin
 * taint, so screenshots capture it). The colour scale is symmetric and auto-ranged to the current frame's
 * largest |ΔT|; the legend labels stay exact, so brightness is comparable within a frame but the ends are
 * this frame's extremes (deliberately not a clip-wide locked span). Overlays (probes, markers) draw on top.
 */
const DiffView = ({ buffer, refBuffer, refLabel, onSetReference }: Props) => {
  const unit = useCommonStore((s) => s.temperatureUnit);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const model = useMemo(() => {
    if (!buffer || !refBuffer) return null;
    try {
      const cur = getDecodedFrame(buffer);
      const ref = getDecodedFrame(refBuffer);
      // A truncated frame carries -273.15 sentinels that would blow out the delta scale; skip like the
      // scale-bar / thumbnail paths do.
      if (!cur.complete || !ref.complete || cur.temps.length !== ref.temps.length) return null;
      const n = cur.temps.length;
      const delta = new Float32Array(n);
      let maxAbs = 0;
      for (let i = 0; i < n; i++) {
        const d = cur.temps[i] - ref.temps[i];
        delta[i] = d;
        const a = Math.abs(d);
        if (a > maxAbs) maxAbs = a;
      }
      return { delta, maxAbs };
    } catch (e) {
      console.error('failed to decode frames for diff view', e);
      return null;
    }
  }, [buffer, refBuffer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { delta, maxAbs } = model;
    const scale = maxAbs < 1e-6 ? 1 : maxAbs; // all-equal frame → uniform neutral, no divide-by-zero
    const img = ctx.createImageData(IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
    for (let i = 0; i < delta.length; i++) {
      const [r, g, b] = delta01ToRgb(delta[i] / scale);
      const o = i * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [model]);

  if (!model) return null;
  const sym = temperatureSymbol(unit);
  const maxDisplay = displayTempDelta(model.maxAbs, unit);

  return (
    <>
      <canvas
        ref={canvasRef}
        width={IR_ARRAY_WIDTH}
        height={IR_ARRAY_HEIGHT}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      />
      <div
        className="diff-legend"
        style={{
          position: 'absolute',
          left: 8,
          bottom: 8,
          pointerEvents: 'none',
          background: 'rgba(0,0,0,0.55)',
          borderRadius: 4,
          padding: '4px 6px',
          fontSize: 10,
          color: 'white',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          minWidth: 120,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>Δ vs {refLabel ?? 'reference'}</span>
          {onSetReference && (
            <button
              type="button"
              className="diff-legend-btn"
              style={{ pointerEvents: 'auto' }}
              title="Set the current frame as the Δ reference"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onSetReference}
            >
              Set ref
            </button>
          )}
        </div>
        <div
          style={{ height: 10, borderRadius: 2, background: DIFF_GRADIENT, boxShadow: '0 0 0 1px rgba(0,0,0,0.5)' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>
            −{maxDisplay.toFixed(1)} {sym}
          </span>
          <span>0</span>
          <span>
            +{maxDisplay.toFixed(1)} {sym}
          </span>
        </div>
      </div>
    </>
  );
};

export default DiffView;
