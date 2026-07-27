import { useMemo, useState } from 'react';
import { InputNumber } from 'antd';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { computeIsotherms, computeIsothermsAt } from '../../../utils/isotherms';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import useCommonStore from '../../../stores/common';
import { displayTemp, fromDisplayTemp, temperatureSymbol } from '../../../utils/helpers';

const LEVELS = 6; // how many evenly-spaced contours AUTO mode draws
const MAX_LOCKED_LEVELS = 8; // cap on user-added locked thresholds (keeps the legend + overlay legible)

interface Props {
  buffer?: ArrayBuffer;
  expId: string;
}

const hueFor = (li: number, total: number) => 240 - (240 * li) / Math.max(1, total - 1);
const swatch = (li: number, total: number) => `hsl(${hueFor(li, total)}, 90%, 55%)`;

// A point to hang a line's on-image temperature label on: the midpoint of its middle segment (segments
// come out of marching-squares in scan order, so the middle one sits roughly along the contour's body).
const labelAnchor = (segments: number[][]): { x: number; y: number } | null => {
  if (!segments.length) return null;
  const s = segments[Math.floor(segments.length / 2)];
  return { x: (s[0] + s[2]) / 2, y: (s[1] + s[3]) / 2 };
};

/**
 * Draws isotherm contour lines over the thermal image for the current frame.
 *
 * By default the contours are AUTO: LEVELS evenly-spaced levels between THIS frame's min and max (so they
 * drift frame to frame). "Edit" opens edit mode, where each legend row is an editable / removable field and
 * a level can be added; the first actual change materialises the drifting levels into a FIXED set
 * (chartSettings.isotherm.lockedLevels) that then holds across the clip — a constant-temperature front can
 * be watched as it moves. "Auto" (top-right) resets to per-frame auto WITHOUT leaving edit mode; "Confirm"
 * (bottom-right) leaves edit mode keeping whatever is set (auto if untouched, else the fixed levels). A
 * fixed level outside a frame's range draws nothing and its row dims. The view legend looks the same
 * whether the levels are auto or fixed.
 */
const Isotherms = ({ buffer, expId }: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const lockedLevels = useCommonStore((s) => s.experimentMap.get(expId)?.chartSettings?.isotherm?.lockedLevels ?? null);
  const labelMode = useCommonStore((s) => s.experimentMap.get(expId)?.chartSettings?.isotherm?.labelMode ?? 'legend');
  const setIsothermSetting = useCommonStore((s) => s.setIsothermSetting);
  const locked = !!lockedLevels && lockedLevels.length > 0;
  const sym = temperatureSymbol(temperatureUnit);
  // Session-only: whether the legend shows editable inputs. Independent of locked/auto — the levels persist,
  // this is just the UI affordance for changing them.
  const [editing, setEditing] = useState(false);

  const decoded = useMemo(() => {
    if (!buffer) return null;
    try {
      return getDecodedFrame(buffer);
    } catch (e) {
      console.error('failed to decode frame for isotherms', e);
      return null;
    }
  }, [buffer]);

  const lines = useMemo(() => {
    if (!decoded) return [];
    return locked
      ? computeIsothermsAt(decoded.temps, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT, lockedLevels as number[])
      : computeIsotherms(decoded.temps, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT, LEVELS);
  }, [decoded, locked, lockedLevels]);

  // The levels an edit acts on: the fixed set if there is one, else the current frame's auto levels (so the
  // first edit while still on auto materialises those into a fixed set). Same count as the rows shown.
  const effectiveLevels = (): number[] => lockedLevels ?? lines.map((l) => l.value);

  const enterEdit = () => setEditing(true); // no persisted change yet — editing a field is what fixes levels
  // Top-right in edit mode: reset to per-frame auto (drifting), staying in edit mode.
  const resetAuto = () => setIsothermSetting(expId, { lockedLevels: null });
  // Bottom-right in edit mode: leave edit mode, keeping whatever is set (auto if untouched, else fixed).
  const confirmEdit = () => setEditing(false);

  const editLevel = (i: number, displayValue: number | null) => {
    if (displayValue === null) return;
    const next = [...effectiveLevels()];
    if (i < 0 || i >= next.length) return;
    next[i] = fromDisplayTemp(displayValue, temperatureUnit);
    setIsothermSetting(expId, { lockedLevels: next });
  };
  const removeLevel = (i: number) => {
    const base = effectiveLevels();
    if (base.length <= 1) return; // keep at least one level once fixed (use Auto to go fully back to drifting)
    setIsothermSetting(expId, { lockedLevels: base.filter((_, idx) => idx !== i) });
  };
  const addLevel = () => {
    if (!decoded) return;
    const base = effectiveLevels();
    if (base.length >= MAX_LOCKED_LEVELS) return;
    setIsothermSetting(expId, { lockedLevels: [...base, (decoded.min + decoded.max) / 2] });
  };

  // Nothing to draw AND nothing fixed AND not editing (no frame) → render nothing at all.
  if (!lines.length && !locked && !editing) return null;

  return (
    <>
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      >
        {lines.map((line, li) =>
          line.segments.map((s, si) => (
            <line
              key={`${li}-${si}`}
              x1={s[0]}
              y1={s[1]}
              x2={s[2]}
              y2={s[3]}
              stroke={swatch(li, lines.length)}
              strokeWidth={0.004}
            />
          )),
        )}
      </svg>

      {/* 'line' mode: no legend box — each contour's temperature is printed directly on the line. */}
      {labelMode === 'line' &&
        lines.map((line, li) => {
          const a = labelAnchor(line.segments); // null when this level isn't present in the frame
          if (!a) return null;
          return (
            <div
              key={li}
              style={{
                position: 'absolute',
                left: `${a.x * 100}%`,
                top: `${a.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                pointerEvents: 'none',
                fontSize: 9,
                fontWeight: 600,
                color: swatch(li, lines.length),
                background: 'rgba(0,0,0,0.6)',
                borderRadius: 3,
                padding: '0 3px',
                whiteSpace: 'nowrap',
              }}
            >
              {displayTemp(line.value, temperatureUnit).toFixed(1)} {sym}
            </div>
          );
        })}

      {labelMode !== 'line' && (
        <div
          className="isotherm-legend"
          onPointerDown={(e) => e.stopPropagation()} // keep edits from clearing the thermometer/line selection
          style={{
            position: 'absolute',
            right: 4,
            bottom: 4,
            background: 'rgba(0,0,0,0.55)',
            borderRadius: 4,
            padding: '4px 6px',
            fontSize: 10,
            color: 'white',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>Isotherms</span>
            {editing && (
              <button type="button" className="isotherm-legend-btn" title="Back to per-frame auto" onClick={resetAuto}>
                Auto
              </button>
            )}
          </div>

          {[...lines]
            .map((line, li) => ({ line, li }))
            .reverse()
            .map(({ line, li }) => {
              const present = line.segments.length > 0; // a fixed level outside this frame's range: dim it
              return (
                <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: present ? 1 : 0.4 }}>
                  <span style={{ width: 10, height: 2, background: swatch(li, lines.length) }} />
                  {editing ? (
                    <>
                      <InputNumber
                        size="small"
                        value={Number(displayTemp(line.value, temperatureUnit).toFixed(1))}
                        onChange={(v) => editLevel(li, v)}
                        step={0.1}
                        precision={1}
                        changeOnWheel
                        style={{ width: 58 }}
                      />
                      <span>{sym}</span>
                      {lines.length > 1 && (
                        <button
                          type="button"
                          className="isotherm-legend-btn"
                          title="Remove this level"
                          onClick={() => removeLevel(li)}
                        >
                          ✕
                        </button>
                      )}
                    </>
                  ) : (
                    <span>
                      {displayTemp(line.value, temperatureUnit).toFixed(1)} {sym}
                    </span>
                  )}
                </div>
              );
            })}

          {editing ? (
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 2 }}
            >
              {(lockedLevels ?? lines).length < MAX_LOCKED_LEVELS ? (
                <button type="button" className="isotherm-legend-btn" onClick={addLevel}>
                  + Add level
                </button>
              ) : (
                <span />
              )}
              <button type="button" className="isotherm-legend-btn" onClick={confirmEdit}>
                Confirm
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="isotherm-legend-btn"
              style={{ alignSelf: 'stretch', marginTop: 2 }}
              title="Edit levels"
              onClick={enterEdit}
            >
              Edit
            </button>
          )}
        </div>
      )}
    </>
  );
};

export default Isotherms;
