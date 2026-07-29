import { CSSProperties, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import useCommonStore from '../../../stores/common';
import { MIN_PROFILE_LENGTH, profileColor } from '../../../utils/lineProfile';
import { getDecodedFrame, DecodedFrame } from '../../../utils/thermalFrame';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { confirmDeleteProfileLine } from '../thermometers/playerContextMenu';
import { ProfileLine as ProfileLineType } from '../../../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number) => `${v * 100}%`;

// A pointer must travel at least this far (fractional) before a press counts as a drag — below it the
// gesture is a click and persists nothing (see startDrag).
const MOVE_THRESHOLD = 0.002;

type DragMode = 'A' | 'B' | 'line';

// Keep the moved endpoint at least MIN_PROFILE_LENGTH from the fixed one, so the transect never collapses
// to a point (which would make the T(l) position axis meaningless). Pushes the endpoint back out along the
// current direction (or a default axis when the two coincide), then clamps into the frame.
const enforceMinLength = (line: ProfileLineType, moved: 'A' | 'B'): ProfileLineType => {
  const fx = moved === 'A' ? line.x2 : line.x1;
  const fy = moved === 'A' ? line.y2 : line.y1;
  const mx = moved === 'A' ? line.x1 : line.x2;
  const my = moved === 'A' ? line.y1 : line.y2;
  let dx = mx - fx;
  let dy = my - fy;
  const len = Math.hypot(dx, dy);
  if (len >= MIN_PROFILE_LENGTH) return line;
  if (len < 1e-6) {
    dx = 1; // coincident → push horizontally by default
    dy = 0;
  } else {
    dx /= len;
    dy /= len;
  }
  let nx = clamp(fx + dx * MIN_PROFILE_LENGTH, 0, 1);
  let ny = clamp(fy + dy * MIN_PROFILE_LENGTH, 0, 1);
  // Clamping into the frame can eat the pushed length back below the minimum when the fixed endpoint sits
  // near the edge the push points toward (e.g. fixed at x=1, push +x). Flip to the opposite direction,
  // which always has room since the fixed endpoint is inside [0,1] and MIN_PROFILE_LENGTH ≤ 1.
  if (Math.hypot(nx - fx, ny - fy) < MIN_PROFILE_LENGTH) {
    nx = clamp(fx - dx * MIN_PROFILE_LENGTH, 0, 1);
    ny = clamp(fy - dy * MIN_PROFILE_LENGTH, 0, 1);
  }
  return moved === 'A' ? { ...line, x1: nx, y1: ny } : { ...line, x2: nx, y2: ny };
};

// Nearest-pixel temperature (display unit) at a fractional point, from the already-decoded frame; null
// when the frame isn't available yet.
const tempAtPoint = (frame: DecodedFrame | null, x: number, y: number, unit: Parameters<typeof displayTemp>[1]) => {
  if (!frame) return null;
  const px = Math.min(frame.width - 1, Math.max(0, Math.floor(x * frame.width)));
  const py = Math.min(frame.height - 1, Math.max(0, Math.floor(y * frame.height)));
  return displayTemp(frame.temps[py * frame.width + px], unit);
};

const lineStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  // The whole layer is transparent to pointer events except the hit shapes below (which re-enable them),
  // so it never blocks a thermometer drag or the right-click menu on the bare image.
  pointerEvents: 'none',
  overflow: 'visible',
};

// Shared text style for the on-image labels (name + endpoint temps): white fill with a dark halo (paint
// the stroke under the fill) so it reads over any palette without a background box.
const labelTextStyle: CSSProperties = { userSelect: 'none', pointerEvents: 'none', paintOrder: 'stroke' };

interface Props {
  expId: string;
  // The displayed frame's decoded-thermal buffer, so the endpoints can show their live temperature. Passed
  // per frame by the players (undefined until a recording's .dat lands); the endpoint labels track playback.
  buffer?: ArrayBuffer;
}

/**
 * The line-profile transects (endpoints A→B) drawn over the frame for the T(l) chart, behaving like the
 * thermometers: added from the toolbar, selected by clicking, renamed / deleted from the right-click menu,
 * deleted with Delete/Backspace. Each line is coloured to match its chart series, shows its name at the
 * midpoint and the live temperature at each endpoint. Anyone can drag one — the owner's placements
 * auto-save, a viewer's stay in their session. Fractional [0,1] endpoints. Captured in screenshots.
 */
const ProfileLineOverlay = ({ expId, buffer }: Props) => {
  const lines = useCommonStore((s) => s.experimentMap.get(expId)?.profileLines);
  const updateProfileLine = useCommonStore((s) => s.updateProfileLine);
  const selectProfileLine = useCommonStore((s) => s.selectProfileLine);
  const hoverProfileLine = useCommonStore((s) => s.hoverProfileLine);
  // Fractional position hovered in the T(l) chart (shared A→B axis), or null. Drives the probe dot below.
  const hoveredPos = useCommonStore((s) => s.hoveredProfilePos);
  const selectedId = useCommonStore((s) => s.selectedProfileLineId);
  const unit = useCommonStore((s) => s.temperatureUnit);
  const drawMode = useCommonStore((s) => s.profileLineDrawMode);
  const setDrawMode = useCommonStore((s) => s.setProfileLineDrawMode);
  const addProfileLine = useCommonStore((s) => s.addProfileLine);
  const svgRef = useRef<SVGSVGElement>(null);
  // The in-progress hand-drawn transect (fractional endpoints), non-null only while the pointer is down in
  // draw mode. Drives the live preview line; committed to a real line on release (if long enough).
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Delete/Backspace removes the selected line (with a confirm, like the thermometer shortcut). Read the
  // selection at event time so this effect needn't re-bind on every selection change; ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = useCommonStore.getState().selectedProfileLineId;
      if (!id) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        confirmDeleteProfileLine(expId, id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expId]);

  // Clear the selection on any press that isn't a profile line (or an open menu) — mirrors the thermometer
  // / annotation deselect. Each overlay runs its own such listener, so clicking a line deselects the
  // thermometer + annotation (their listeners fire too), and clicking either of those deselects the line.
  useEffect(() => {
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.profile-line-hit') || t?.closest?.('.ant-dropdown-menu')) return;
      useCommonStore.getState().selectProfileLine(null);
    };
    document.addEventListener('pointerdown', onDocDown);
    return () => document.removeEventListener('pointerdown', onDocDown);
  }, []);

  // While arming a hand-draw, Escape cancels the gesture and disarms (drops the in-progress preview).
  useEffect(() => {
    if (!drawMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDraft(null);
        setDrawMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawMode, setDrawMode]);

  // Press-drag-release over the frame to draw a new transect: A = press point, B = release point. A bare
  // click (or a too-short drag) draws nothing and just disarms — mirrors the min-length rule for editing.
  const startDraw = (e: ReactPointerEvent) => {
    if (e.button === 2) return; // ignore right-click
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const toFrac = (clientX: number, clientY: number) => {
      const rect = svg.getBoundingClientRect();
      return {
        fx: clamp((clientX - rect.left) / rect.width, 0, 1),
        fy: clamp((clientY - rect.top) / rect.height, 0, 1),
      };
    };
    const a = toFrac(e.clientX, e.clientY);
    setDraft({ x1: a.fx, y1: a.fy, x2: a.fx, y2: a.fy });

    const onMove = (ev: PointerEvent) => {
      const b = toFrac(ev.clientX, ev.clientY);
      setDraft({ x1: a.fx, y1: a.fy, x2: b.fx, y2: b.fy });
    };
    // Same touch-scroll suppression the edit drag uses (touch-action:none is unreliable on SVG sub-elements).
    const onTouchMove = (ev: TouchEvent) => ev.preventDefault();
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('touchmove', onTouchMove);
    };
    const onUp = (ev: PointerEvent) => {
      cleanup();
      const b = toFrac(ev.clientX, ev.clientY);
      setDraft(null);
      setDrawMode(false);
      if (Math.hypot(b.fx - a.fx, b.fy - a.fy) >= MIN_PROFILE_LENGTH) {
        addProfileLine(expId, { x1: a.fx, y1: a.fy, x2: b.fx, y2: b.fy });
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  };

  const startDrag = (e: ReactPointerEvent, target: ProfileLineType, mode: DragMode) => {
    if (e.button === 2) return; // let right-click through (onContextMenu selects; the player menu opens)
    // NOT stopPropagation: the sibling overlays' document listeners must see this press to deselect their
    // own thermometer / annotation, and ours (above) keeps the line selected because the target is a hit shape.
    e.preventDefault();
    selectProfileLine(target.id);
    const svg = svgRef.current;
    if (!svg) return;
    const start = target; // freeze the geometry at gesture start (keeps id/name; body translate is relative)

    const toFrac = (clientX: number, clientY: number) => {
      const rect = svg.getBoundingClientRect();
      return {
        fx: clamp((clientX - rect.left) / rect.width, 0, 1),
        fy: clamp((clientY - rect.top) / rect.height, 0, 1),
      };
    };
    const startPtr = toFrac(e.clientX, e.clientY);

    const compute = (clientX: number, clientY: number): ProfileLineType => {
      const { fx, fy } = toFrac(clientX, clientY);
      if (mode === 'A') return enforceMinLength({ ...start, x1: fx, y1: fy }, 'A');
      if (mode === 'B') return enforceMinLength({ ...start, x2: fx, y2: fy }, 'B');
      // Translate the whole line by the pointer delta, clamped so BOTH endpoints stay in the frame.
      let dfx = fx - startPtr.fx;
      let dfy = fy - startPtr.fy;
      dfx = clamp(dfx, -Math.min(start.x1, start.x2), 1 - Math.max(start.x1, start.x2));
      dfy = clamp(dfy, -Math.min(start.y1, start.y2), 1 - Math.max(start.y1, start.y2));
      return { ...start, x1: start.x1 + dfx, y1: start.y1 + dfy, x2: start.x2 + dfx, y2: start.y2 + dfy };
    };

    // A bare click (no real movement) writes NOTHING, so it can't spuriously re-persist an unchanged line
    // (bumping updatedAt for the owner). Only a genuine drag persists.
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        const { fx, fy } = toFrac(ev.clientX, ev.clientY);
        if (Math.hypot(fx - startPtr.fx, fy - startPtr.fy) < MOVE_THRESHOLD) return;
        moved = true;
      }
      updateProfileLine(expId, compute(ev.clientX, ev.clientY));
    };
    // touch-action:none is unreliable on SVG sub-elements (iOS Safari), so stop the page scrolling with a
    // native non-passive touchmove — same technique the annotation drag and thermometer resize handles use.
    const onTouchMove = (ev: TouchEvent) => ev.preventDefault();
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.removeEventListener('touchmove', onTouchMove);
    };
    const onUp = (ev: PointerEvent) => {
      cleanup();
      if (moved) updateProfileLine(expId, compute(ev.clientX, ev.clientY));
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  };

  // Render the layer when a transect exists OR the user is arming a draw (so the crosshair capture surface
  // and preview have somewhere to live even before the first line exists).
  if (!lines?.length && !drawMode) return null;
  const list = lines ?? [];

  // Decode the current frame once (LRU-cached, shared with the chart/isotherms) for the endpoint readouts.
  let frame: DecodedFrame | null = null;
  if (buffer) {
    try {
      frame = getDecodedFrame(buffer);
    } catch {
      frame = null;
    }
  }
  const unitSymbol = temperatureSymbol(unit);
  const hitR = 13; // transparent grab radius (px) — comfortably above the 24px min touch target (diameter)

  // Colour the new line will take once committed — used for the live preview so it reads as "this line".
  const draftColor = profileColor(list.length);

  return (
    <svg ref={svgRef} style={lineStyle}>
      {list.map((line, i) => {
        const color = profileColor(i);
        const selected = line.id === selectedId;
        const handleR = selected ? 9.5 : 8; // visible endpoint radius (px), enlarged when selected (fits the A/B letter)
        const name = line.name?.trim() || `L${i + 1}`;
        const midX = (line.x1 + line.x2) / 2;
        const midY = (line.y1 + line.y2) / 2;
        // Probe point mirrored from the T(l) chart hover: interpolate the hovered position along A→B.
        const probe =
          hoveredPos != null
            ? { x: line.x1 + (line.x2 - line.x1) * hoveredPos, y: line.y1 + (line.y2 - line.y1) * hoveredPos }
            : null;
        const tempA = tempAtPoint(frame, line.x1, line.y1, unit);
        const tempB = tempAtPoint(frame, line.x2, line.y2, unit);
        return (
          // Hovering anywhere on the transect (body or an endpoint) mirrors the thermometer hover: it
          // highlights this line's series in the T(l) chart and dims the others. onPointerEnter/Leave on
          // the group fire once for the whole line — React's synthetic enter/leave don't retrigger when
          // the pointer moves between the body hit-line and an endpoint handle (same group), so no flicker.
          <g
            key={line.id}
            onPointerEnter={() => hoverProfileLine(line.id)}
            onPointerLeave={() => hoverProfileLine(null)}
          >
            {/* Dark underlay + coloured line for contrast over any palette; thicker + a soft halo when selected. */}
            <line
              x1={pct(line.x1)}
              y1={pct(line.y1)}
              x2={pct(line.x2)}
              y2={pct(line.y2)}
              stroke="rgba(0,0,0,0.55)"
              strokeWidth={selected ? 6 : 4}
              strokeLinecap="round"
            />
            {selected && (
              <line
                x1={pct(line.x1)}
                y1={pct(line.y1)}
                x2={pct(line.x2)}
                y2={pct(line.y2)}
                stroke="#fff"
                strokeWidth={5}
                strokeLinecap="round"
                strokeOpacity={0.6}
              />
            )}
            <line
              x1={pct(line.x1)}
              y1={pct(line.y1)}
              x2={pct(line.x2)}
              y2={pct(line.y2)}
              stroke={color}
              strokeWidth={selected ? 3 : 2}
              strokeLinecap="round"
            />

            {/* Wide transparent hit line for grabbing the body (translate) + right-click to select. */}
            <line
              className="profile-line-hit"
              x1={pct(line.x1)}
              y1={pct(line.y1)}
              x2={pct(line.x2)}
              y2={pct(line.y2)}
              stroke="transparent"
              strokeWidth={16}
              strokeLinecap="round"
              style={{ pointerEvents: 'stroke', cursor: 'move' }}
              onPointerDown={(e) => startDrag(e, line, 'line')}
              onContextMenu={() => selectProfileLine(line.id)}
            />

            {/* Name at the line's midpoint (offset up a few px so it clears the line). */}
            <text
              x={pct(midX)}
              y={pct(midY)}
              transform="translate(0,-9)"
              textAnchor="middle"
              fontSize={12}
              fontWeight={700}
              fill={color}
              stroke="rgba(0,0,0,0.75)"
              strokeWidth={2.4}
              style={labelTextStyle}
            >
              {name}
            </text>

            {/* Endpoint handles: visible dot + temperature readout + transparent grab circle. */}
            {(['A', 'B'] as const).map((end) => {
              const x = end === 'A' ? line.x1 : line.x2;
              const y = end === 'A' ? line.y1 : line.y2;
              const temp = end === 'A' ? tempA : tempB;
              return (
                <g key={end}>
                  <circle
                    cx={pct(x)}
                    cy={pct(y)}
                    r={handleR}
                    fill={color}
                    stroke={selected ? '#fff' : 'rgba(0,0,0,0.6)'}
                    strokeWidth={selected ? 2 : 1.5}
                  />
                  {/* A/B letter inside the handle so the transect reads as directed (A = start, B = end),
                      matching the chart's "Position along line (A→B)" axis. */}
                  <text
                    x={pct(x)}
                    y={pct(y)}
                    dominantBaseline="central"
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={800}
                    fill="#fff"
                    stroke="rgba(0,0,0,0.5)"
                    strokeWidth={1.8}
                    style={labelTextStyle}
                  >
                    {end}
                  </text>
                  {temp != null && (
                    <text
                      x={pct(x)}
                      y={pct(y)}
                      transform="translate(0,20)"
                      textAnchor="middle"
                      fontSize={11}
                      fontVariantNumeric="tabular-nums"
                      fill="#fff"
                      stroke="rgba(0,0,0,0.8)"
                      strokeWidth={2.4}
                      style={labelTextStyle}
                    >
                      {`${temp.toFixed(1)}${unitSymbol}`}
                    </text>
                  )}
                  <circle
                    className="profile-line-hit"
                    cx={pct(x)}
                    cy={pct(y)}
                    r={hitR}
                    fill="transparent"
                    style={{ pointerEvents: 'all', cursor: 'grab' }}
                    onPointerDown={(e) => startDrag(e, line, end)}
                    onContextMenu={() => selectProfileLine(line.id)}
                  />
                </g>
              );
            })}

            {/* Probe dot tracking the T(l) chart hover — a white disc with the line's colour, non-interactive
                so it never intercepts a drag. Rendered last so it sits above the transect and its endpoints. */}
            {probe && (
              <g style={{ pointerEvents: 'none' }}>
                <circle
                  cx={pct(probe.x)}
                  cy={pct(probe.y)}
                  r={6}
                  fill="#fff"
                  stroke="rgba(0,0,0,0.7)"
                  strokeWidth={3.5}
                />
                <circle cx={pct(probe.x)} cy={pct(probe.y)} r={6} fill="#fff" stroke={color} strokeWidth={2} />
                <circle cx={pct(probe.x)} cy={pct(probe.y)} r={2.5} fill={color} />
              </g>
            )}
          </g>
        );
      })}

      {/* Draw mode: a full-frame crosshair capture surface (topmost, so it intercepts every press) plus the
          live preview of the line being dragged. Only mounted while arming, so it never blocks normal edits. */}
      {drawMode && (
        <>
          <rect
            x={0}
            y={0}
            width="100%"
            height="100%"
            fill="transparent"
            style={{ pointerEvents: 'all', cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={startDraw}
          />
          {draft && (
            <g style={{ pointerEvents: 'none' }}>
              <line
                x1={pct(draft.x1)}
                y1={pct(draft.y1)}
                x2={pct(draft.x2)}
                y2={pct(draft.y2)}
                stroke="rgba(0,0,0,0.55)"
                strokeWidth={5}
                strokeLinecap="round"
              />
              <line
                x1={pct(draft.x1)}
                y1={pct(draft.y1)}
                x2={pct(draft.x2)}
                y2={pct(draft.y2)}
                stroke={draftColor}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray="6 4"
              />
              {(['A', 'B'] as const).map((end) => {
                const x = end === 'A' ? draft.x1 : draft.x2;
                const y = end === 'A' ? draft.y1 : draft.y2;
                return (
                  <circle key={end} cx={pct(x)} cy={pct(y)} r={5} fill={draftColor} stroke="#fff" strokeWidth={1.5} />
                );
              })}
            </g>
          )}
        </>
      )}
    </svg>
  );
};

export default ProfileLineOverlay;
