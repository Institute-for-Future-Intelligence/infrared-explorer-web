import { CSSProperties, PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from 'react';
import useCommonStore from '../../../stores/common';
import { MIN_PROFILE_LENGTH, profileColor, sampleLineProfile } from '../../../utils/lineProfile';
import { getDecodedFrame, DecodedFrame } from '../../../utils/thermalFrame';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { isToggleClick } from '../frameItemSelection';
import { ProfileLine as ProfileLineType } from '../../../types';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Path coordinates rounded to 1/100 px so the tick/hole strings stay short.
const f = (v: number) => Math.round(v * 100) / 100;

// A pointer must travel at least this far (fractional) before a press counts as a drag — below it the
// gesture is a click and persists nothing (see startDrag).
const MOVE_THRESHOLD = 0.002;

type DragMode = 'A' | 'B' | 'line';

// ---- The app's thermoruler, in CSS px -----------------------------------------------------------------
// The marker is the app's thermoruler (ProbeOverlay.tsx, itself a port of the Android Thermoruler): a
// translucent white band with a drop shadow, a white edge, inward ticks on both edges (a long one every
// fifth), a row of dark "holes" down the centreline, and the L# label + the live min-max ø mean floating
// beside the line, rotated to its angle. The app draws it in reference px scaled to the phone's width
// (px(v) = v·W/1080); on a 360-dp phone that is v/3, which also sits right beside the web's fixed-size
// thermometer glyph, so the same 1/3 is used here as a fixed CSS-px scale (the sizes keep the app's names).
const REF = 1 / 3;
const HALF_WIDTH = 25 * REF; // rulerHalfWidth
const EDGE_STROKE = 4 * REF; // rulerEdgeStroke
const HOLE_R = 3 * REF; // rulerHoleRadius
const HOLE_STROKE = 2 * REF; // rulerHoleStroke
const MINOR_TICK = 5 * REF; // rulerMinorTick
const MAJOR_TICK = 10 * REF; // rulerMajorTick, every fifth measure point
const MEASURE_SPACING = 20 * REF; // rulerMeasureSpacing: one tick pair + hole per measure point
const LABEL_FONT = 36 * REF; // textNormal
const LINE_H = Math.round(LABEL_FONT * 1.17); // the font's ascent + descent
const PILL_PAD_X = 20 * REF; // label pill: drawRoundRect(tx-20, ty-100, tx+lx+20, ty-40, 10)
const PILL_H = 60 * REF;
const PILL_R = 10 * REF;
const STATS_PAD = 2 * REF; // stats box: 2 ref-px of padding around the text
const STATS_GAP = 8 * REF; // stats baseline = label baseline + line height + 8 ref-px
// The app floats the label 70 ref-px off the centreline, which lets the stats line run into the band; here
// the block is pushed up until the stats box clears the band's edge by this much.
const BLOCK_CLEARANCE = 2;
const SHADOW = { dx: 5 * REF, dy: 5 * REF, sigma: 10 * REF * 0.5774 }; // rulerPaint.setShadowLayer(10, 5, 5, BLACK)
const BAND_FILL = 'rgba(255,255,255,0.333)'; // colors.rulerBand (0x55FFFFFF)
const HOLE_FILL = '#444444'; // colors.canvasDkGray
const LABEL_BG = 'rgba(0,0,0,0.667)'; // colors.labelBackground (0xAA000000)
const FONT_FAMILY = 'Helvetica, Arial, sans-serif'; // the app's Helvetica / sans-serif
const LABEL_FONT_CSS = `${LABEL_FONT}px ${FONT_FAMILY}`;
// State accents shared with the thermometer marker: amber while selected, teal while hovered.
const SELECTED = '#ffc53d';
const HOVERED = '#1fb6a6';
const END_HANDLE_R = 5.5; // endpoint grab handle, shown while the line is selected or hovered

// Synchronous text measurement for the label pills (the app measures with the Skia font the same way), on
// one shared off-screen 2D context.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const textWidth = (text: string, font: string) => {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * LABEL_FONT * 0.6;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
};

// The band polygon, the tick marks and the centreline holes of a ruler between two px points, as SVG path
// data (one path per kind: a long ruler has dozens of measure points). Mirrors the app's buildGeometry.
const rulerPaths = (x1: number, y1: number, x2: number, y2: number) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  // unit normal n = normalize(-(y2-y1), x2-x1)
  const nx = -(y2 - y1) / length;
  const ny = (x2 - x1) / length;
  const dx = nx * HALF_WIDTH;
  const dy = ny * HALF_WIDTH;
  const band = `M${f(x1 - dx)},${f(y1 - dy)} L${f(x2 - dx)},${f(y2 - dy)} L${f(x2 + dx)},${f(y2 + dy)} L${f(
    x1 + dx,
  )},${f(y1 + dy)} Z`;
  // Measure points: one every MEASURE_SPACING of length (the app's measurePointCount).
  const points = Math.round(length / MEASURE_SPACING);
  const delta = length / points;
  const cos = (x2 - x1) / length;
  const sin = (y2 - y1) / length;
  let ticks = '';
  let holes = '';
  for (let i = 1; i < points; i++) {
    const tick = i % 5 === 0 ? MAJOR_TICK : MINOR_TICK;
    // -n edge, tick inward along +n
    let xi = x1 - dx + delta * i * cos;
    let yi = y1 - dy + delta * i * sin;
    ticks += `M${f(xi)},${f(yi)} L${f(xi + nx * tick)},${f(yi + ny * tick)} `;
    // centreline hole
    xi += dx;
    yi += dy;
    holes += `M${f(xi - HOLE_R)},${f(yi)} a${HOLE_R},${HOLE_R} 0 1 0 ${2 * HOLE_R},0 a${HOLE_R},${HOLE_R} 0 1 0 ${
      -2 * HOLE_R
    },0 `;
    // +n edge, tick inward along -n
    xi += dx;
    yi += dy;
    ticks += `M${f(xi)},${f(yi)} L${f(xi - nx * tick)},${f(yi - ny * tick)} `;
  }
  return { band, ticks, holes };
};

// Keep the moved endpoint at least MIN_PROFILE_LENGTH from the fixed one, so the transect never collapses
// to a point (which would make the T(r) position axis meaningless). Pushes the endpoint back out along the
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

// The ruler's live readout, like the app's: min-max and ø mean of the temperatures along the line for the
// displayed frame, in the display unit. Off-image / truncated pixels carry the format's -273.15 sentinel
// and are skipped; null when nothing finite is left (or there's no frame yet).
const lineStats = (frame: DecodedFrame | null, line: ProfileLineType, unit: Parameters<typeof displayTemp>[1]) => {
  if (!frame) return null;
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  let cnt = 0;
  for (const s of sampleLineProfile(frame.temps, frame.width, frame.height, line)) {
    const v = s.tempC;
    if (!Number.isFinite(v) || v <= -273) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
    cnt++;
  }
  if (!cnt) return null;
  const sym = temperatureSymbol(unit);
  return `${displayTemp(mn, unit).toFixed(1)}-${displayTemp(mx, unit).toFixed(1)} ø${displayTemp(
    sum / cnt,
    unit,
  ).toFixed(1)}${sym}`;
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

// Label text: font inline (not via a stylesheet) so a screenshot's SVG rasterization sees the same face.
const labelTextStyle: CSSProperties = { userSelect: 'none', pointerEvents: 'none', fontFamily: FONT_FAMILY };
// The readout line: tabular digits so the numbers don't jitter from frame to frame.
const statsTextStyle: CSSProperties = { ...labelTextStyle, fontVariantNumeric: 'tabular-nums' };
// The A/B endpoint letters: white with a dark halo (paint the stroke under the fill).
const endLetterStyle: CSSProperties = { ...labelTextStyle, paintOrder: 'stroke' };

interface Props {
  expId: string;
  // The displayed frame's decoded-thermal buffer, so the ruler can show its live readout. Passed per frame
  // by the players (undefined until a recording's .dat lands); the readout tracks playback.
  buffer?: ArrayBuffer;
}

/**
 * The line-profile transects (endpoints A→B) drawn over the frame for the T(r) chart, styled as the app's
 * thermoruler (see the constants above) and behaving like the thermometers: added from the toolbar,
 * selected by clicking (Shift / Ctrl / ⌘-click to select several, thermometers and notes included),
 * renamed / deleted from the right-click menu, deleted with Delete/Backspace (useFrameSelectionControls).
 * Each ruler's label is coloured to match its chart series and carries the live min-max ø mean along the
 * line. Anyone can drag one by its band or, while it is selected or hovered, by an endpoint handle — the
 * owner's placements auto-save, a viewer's stay in their session. Fractional [0,1] endpoints. Captured in
 * screenshots.
 */
const ProfileLineOverlay = ({ expId, buffer }: Props) => {
  const lines = useCommonStore((s) => s.experimentMap.get(expId)?.profileLines);
  const updateProfileLine = useCommonStore((s) => s.updateProfileLine);
  const selectFrameItem = useCommonStore((s) => s.selectFrameItem);
  const hoverProfileLine = useCommonStore((s) => s.hoverProfileLine);
  const hoveredId = useCommonStore((s) => s.hoveredProfileLineId);
  // Fractional position hovered in the T(r) chart (shared A→B axis), or null. Drives the probe dot below.
  const hoveredPos = useCommonStore((s) => s.hoveredProfilePos);
  const selectedIds = useCommonStore((s) => s.frameSelection.profileLines);
  const unit = useCommonStore((s) => s.temperatureUnit);
  const drawMode = useCommonStore((s) => s.profileLineDrawMode);
  const setDrawMode = useCommonStore((s) => s.setProfileLineDrawMode);
  const addProfileLine = useCommonStore((s) => s.addProfileLine);
  const svgRef = useRef<SVGSVGElement>(null);
  // The in-progress hand-drawn transect (fractional endpoints), non-null only while the pointer is down in
  // draw mode. Drives the live preview line; committed to a real line on release (if long enough).
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // The layer's size in CSS px: the endpoints are fractional, but the band width, ticks, holes and labels
  // are fixed px, so the geometry is laid out in px and re-laid on every resize of the player.
  const [size, setSize] = useState({ w: 0, h: 0 });

  const mounted = !!lines?.length || drawMode;
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || !mounted) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, [mounted]);

  // While arming a hand-draw, Escape cancels the gesture and disarms (drops the in-progress preview).
  useLayoutEffect(() => {
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
    e.preventDefault();
    // Shift / Ctrl / ⌘-click adds the line to the selection (or takes it out) and doesn't drag it.
    if (isToggleClick(e)) {
      selectFrameItem('profileLines', target.id, 'toggle');
      return;
    }
    selectFrameItem('profileLines', target.id);
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
  if (!mounted) return null;
  const list = lines ?? [];

  // Decode the current frame once (LRU-cached, shared with the chart/isotherms) for the readouts.
  let frame: DecodedFrame | null = null;
  if (buffer) {
    try {
      frame = getDecodedFrame(buffer);
    } catch {
      frame = null;
    }
  }
  const hitR = 13; // transparent grab radius (px) — comfortably above the 24px min touch target (diameter)
  const { w, h } = size;
  const laidOut = w > 0 && h > 0; // the px geometry needs the measured size (one frame after mount)
  const shadowId = `ruler-shadow-${expId}`;

  // Label block layout in the ruler's local frame (x along the line, y across it, the block on the -y side):
  // the stats box sits just clear of the band's edge and the label pill above it, the two lines spaced as
  // in the app (line height + 8 ref-px between baselines).
  const statsH = LINE_H + 2 * STATS_PAD;
  const statsCy = -(HALF_WIDTH + EDGE_STROKE / 2 + BLOCK_CLEARANCE + statsH / 2);
  const labelCy = statsCy - (LINE_H + STATS_GAP);

  // Colour the new line will take once committed — used for the live preview so it reads as "this line".
  const draftColor = profileColor(list.length);

  return (
    <svg ref={svgRef} style={lineStyle}>
      <defs>
        {/* The band's drop shadow. Region in user space: the default bbox-relative region clips the shadow
            of a thin horizontal/vertical band. */}
        <filter id={shadowId} x="-10%" y="-10%" width="120%" height="120%" filterUnits="userSpaceOnUse">
          <feDropShadow dx={SHADOW.dx} dy={SHADOW.dy} stdDeviation={SHADOW.sigma} floodColor="#000" />
        </filter>
      </defs>
      {laidOut &&
        list.map((line, i) => {
          const color = profileColor(i);
          const selected = selectedIds.includes(line.id);
          const hovered = hoveredId === line.id;
          const x1 = line.x1 * w;
          const y1 = line.y1 * h;
          const x2 = line.x2 * w;
          const y2 = line.y2 * h;
          const length = Math.hypot(x2 - x1, y2 - y1);
          if (length < 1e-6) return null;
          const { band, ticks, holes } = rulerPaths(x1, y1, x2, y2);
          const cx = (x1 + x2) / 2;
          const cy = (y1 + y2) / 2;
          // The label group is rotated to the line's A→B angle about its midpoint, so the text reads from
          // A to B exactly as in the app: its direction says which way the ruler runs (one drawn right to
          // left reads upside-down, and the A and B at the ends agree). The block sits on the ruler's
          // left-hand side walking from A to B.
          const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
          const name = line.name?.trim() || `L${i + 1}`;
          const nameW = textWidth(name, LABEL_FONT_CSS);
          const stats = lineStats(frame, line, unit);
          const statsW = stats ? textWidth(stats, LABEL_FONT_CSS) : 0;
          const edge = selected ? SELECTED : hovered ? HOVERED : '#fff';
          // Probe point mirrored from the T(r) chart hover: interpolate the hovered position along A→B.
          const probe = hoveredPos != null ? { x: x1 + (x2 - x1) * hoveredPos, y: y1 + (y2 - y1) * hoveredPos } : null;
          // Unit direction A→B, for the endpoint letters.
          const ux = (x2 - x1) / length;
          const uy = (y2 - y1) / length;
          return (
            // Hovering anywhere on the ruler (band or an endpoint) mirrors the thermometer hover: it
            // highlights this line's series in the T(r) chart and dims the others. onPointerEnter/Leave on
            // the group fire once for the whole line — React's synthetic enter/leave don't retrigger when
            // the pointer moves between the band and an endpoint handle (same group), so no flicker.
            <g
              key={line.id}
              onPointerEnter={() => hoverProfileLine(line.id)}
              onPointerLeave={() => hoverProfileLine(null)}
            >
              {/* Band (with its shadow) + edge; the edge takes the state accent. */}
              <path d={band} fill={BAND_FILL} filter={`url(#${shadowId})`} />
              <path d={band} fill="none" stroke={edge} strokeWidth={EDGE_STROKE} strokeLinejoin="miter" />
              {/* Ticks on both edges, holes down the centreline. */}
              <path d={ticks} fill="none" stroke="#fff" strokeWidth={HOLE_STROKE} />
              <path d={holes} fill={HOLE_FILL} stroke="#fff" strokeWidth={HOLE_STROKE} />

              {/* Wide transparent hit line for grabbing the body (translate) + right-click to select. */}
              <line
                className="profile-line-hit"
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="transparent"
                strokeWidth={Math.max(24, 2 * HALF_WIDTH)}
                strokeLinecap="butt"
                style={{ pointerEvents: 'stroke', cursor: 'move' }}
                onPointerDown={(e) => startDrag(e, line, 'line')}
                onContextMenu={() => selectFrameItem('profileLines', line.id, 'ensure')}
              />

              {/* L# label pill + the live min-max ø mean beneath it, rotated to the line beside its midpoint.
                  The series colour names the ruler, as in the app; the selected pill turns amber with dark
                  text like a selected thermometer's. */}
              <g transform={`translate(${f(cx)},${f(cy)}) rotate(${f(angle)})`}>
                <rect
                  x={-nameW / 2 - PILL_PAD_X}
                  y={labelCy - PILL_H / 2}
                  width={nameW + 2 * PILL_PAD_X}
                  height={PILL_H}
                  rx={PILL_R}
                  fill={selected ? SELECTED : LABEL_BG}
                />
                <text
                  x={0}
                  y={labelCy}
                  dominantBaseline="central"
                  textAnchor="middle"
                  fontSize={LABEL_FONT}
                  fill={selected ? '#1f1600' : color}
                  style={labelTextStyle}
                >
                  {name}
                </text>
                {stats && (
                  <>
                    <rect
                      x={-statsW / 2 - STATS_PAD}
                      y={statsCy - statsH / 2}
                      width={statsW + 2 * STATS_PAD}
                      height={statsH}
                      fill={LABEL_BG}
                    />
                    <text
                      x={0}
                      y={statsCy}
                      dominantBaseline="central"
                      textAnchor="middle"
                      fontSize={LABEL_FONT}
                      fill={color}
                      style={statsTextStyle}
                    >
                      {stats}
                    </text>
                  </>
                )}
              </g>

              {/* Endpoints: the A/B letters just beyond each end, always, so the ruler reads as directed
                  (A = start, B = end, the chart's "Position along thermoruler (A→B)" axis — the app shows
                  them too); a grab handle while the line is selected or hovered (the app's ruler is
                  grabbed by touch near its ends, a mouse needs the affordance); and the transparent grab
                  circle always. */}
              {(['A', 'B'] as const).map((end) => {
                const x = end === 'A' ? x1 : x2;
                const y = end === 'A' ? y1 : y2;
                const dir = end === 'A' ? -1 : 1;
                return (
                  <g key={end}>
                    {(selected || hovered) && (
                      <circle cx={x} cy={y} r={END_HANDLE_R} fill="#fff" stroke="rgba(0,0,0,0.35)" strokeWidth={1} />
                    )}
                    <text
                      x={x + ux * dir * (END_HANDLE_R + 8)}
                      y={y + uy * dir * (END_HANDLE_R + 8)}
                      dominantBaseline="central"
                      textAnchor="middle"
                      fontSize={10}
                      fontWeight={700}
                      fill="#fff"
                      stroke="rgba(0,0,0,0.75)"
                      strokeWidth={2.4}
                      style={endLetterStyle}
                    >
                      {end}
                    </text>
                    <circle
                      className="profile-line-hit"
                      cx={x}
                      cy={y}
                      r={hitR}
                      fill="transparent"
                      style={{ pointerEvents: 'all', cursor: 'grab' }}
                      onPointerDown={(e) => startDrag(e, line, end)}
                      onContextMenu={() => selectFrameItem('profileLines', line.id, 'ensure')}
                    />
                  </g>
                );
              })}

              {/* Probe dot tracking the T(r) chart hover — a white disc ringed in the line's colour, sitting
                  on the centreline like a lit hole; non-interactive so it never intercepts a drag. Rendered
                  last so it sits above the band and its endpoints. */}
              {probe && (
                <g style={{ pointerEvents: 'none' }}>
                  <circle cx={probe.x} cy={probe.y} r={4.5} fill="#fff" stroke="rgba(0,0,0,0.7)" strokeWidth={3.5} />
                  <circle cx={probe.x} cy={probe.y} r={4.5} fill="#fff" stroke={color} strokeWidth={2} />
                  <circle cx={probe.x} cy={probe.y} r={2} fill={color} />
                </g>
              )}
            </g>
          );
        })}

      {/* Draw mode: a full-frame crosshair capture surface (topmost, so it intercepts every press) plus the
          live preview of the ruler being dragged out: the band with a dashed edge in the colour the line
          will take. Only mounted while arming, so it never blocks normal edits. */}
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
          {draft &&
            laidOut &&
            (() => {
              const x1 = draft.x1 * w;
              const y1 = draft.y1 * h;
              const x2 = draft.x2 * w;
              const y2 = draft.y2 * h;
              if (Math.hypot(x2 - x1, y2 - y1) < 1e-6) return null;
              const { band } = rulerPaths(x1, y1, x2, y2);
              return (
                <g style={{ pointerEvents: 'none' }}>
                  <path d={band} fill="rgba(255,255,255,0.2)" />
                  <path d={band} fill="none" stroke={draftColor} strokeWidth={EDGE_STROKE} strokeDasharray="6 4" />
                  {(['A', 'B'] as const).map((end) => {
                    const x = end === 'A' ? x1 : x2;
                    const y = end === 'A' ? y1 : y2;
                    return <circle key={end} cx={x} cy={y} r={5} fill={draftColor} stroke="#fff" strokeWidth={1.5} />;
                  })}
                </g>
              );
            })()}
        </>
      )}
    </svg>
  );
};

export default ProfileLineOverlay;
