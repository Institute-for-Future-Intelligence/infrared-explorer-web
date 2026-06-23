import { useMemo } from 'react';
import { getTempFromArrayBuffer } from '../../../utils/temperatureReader';
import { computeIsotherms } from '../../../utils/isotherms';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';

const LEVELS = 6;

interface Props {
  buffer?: ArrayBuffer;
}

/** Draws isotherm contour lines over the thermal image for the current frame. */
const Isotherms = ({ buffer }: Props) => {
  const lines = useMemo(() => {
    if (!buffer) return [];
    try {
      const grid = getTempFromArrayBuffer(buffer); // per-pixel Celsius for the frame
      return computeIsotherms(grid, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT, LEVELS);
    } catch (e) {
      console.error('failed to compute isotherms', e);
      return [];
    }
  }, [buffer]);

  if (!lines.length) return null;

  return (
    <svg
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {lines.map((line, li) => {
        // cool (blue) -> warm (red) across levels
        const hue = 240 - (240 * li) / Math.max(1, lines.length - 1);
        const color = `hsl(${hue}, 90%, 55%)`;
        return line.segments.map((s, si) => (
          <line key={`${li}-${si}`} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} stroke={color} strokeWidth={0.004} />
        ));
      })}
    </svg>
  );
};

export default Isotherms;
