import { useMemo } from 'react';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { computeIsotherms } from '../../../utils/isotherms';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import useCommonStore from '../../../stores/common';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';

const LEVELS = 6;

interface Props {
  buffer?: ArrayBuffer;
}

const hueFor = (li: number, total: number) => 240 - (240 * li) / Math.max(1, total - 1);

/** Draws isotherm contour lines over the thermal image for the current frame. */
const Isotherms = ({ buffer }: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const lines = useMemo(() => {
    if (!buffer) return [];
    try {
      const { temps } = getDecodedFrame(buffer); // per-pixel Celsius for the frame (decoded once, cached)
      return computeIsotherms(temps, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT, LEVELS);
    } catch (e) {
      console.error('failed to compute isotherms', e);
      return [];
    }
  }, [buffer]);

  if (!lines.length) return null;

  return (
    <>
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        {lines.map((line, li) => {
          const color = `hsl(${hueFor(li, lines.length)}, 90%, 55%)`;
          return line.segments.map((s, si) => (
            <line key={`${li}-${si}`} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} stroke={color} strokeWidth={0.004} />
          ));
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          right: 4,
          bottom: 4,
          pointerEvents: 'none',
          background: 'rgba(0,0,0,0.5)',
          borderRadius: 4,
          padding: '4px 6px',
          fontSize: 10,
          color: 'white',
        }}
      >
        {[...lines].reverse().map((line, i) => {
          const li = lines.length - 1 - i; // keep colors matching the lines (warm at top)
          return (
            <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 2, background: `hsl(${hueFor(li, lines.length)}, 90%, 55%)` }} />
              {displayTemp(line.value, temperatureUnit).toFixed(1)} {temperatureSymbol(temperatureUnit)}
            </div>
          );
        })}
      </div>
    </>
  );
};

export default Isotherms;
