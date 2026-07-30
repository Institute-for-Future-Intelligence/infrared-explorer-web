import {
  CartesianGrid,
  Customized,
  Label,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MARGIN, PRESET_COLORS, Y_AXIS_WIDTH } from '../../../utils/constants';
import useCommonStore, { DEFAULT_LINE_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, LineChartSettings, LineplotData, TemperatureUnit, Thermometer } from '../../../types';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { displayTemp, niceTemperatureAxis, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { ExpFit, MIN_FIT_POINTS, fitNewtonCooling, sampleExpFit } from '../../../utils/curveFit';
import ChartMenu from './chartMenu';
import { renderYAxisTitle, yTickFormatter } from './chartLabels';

interface WrapperProps {
  expId: string;
  thermometersId: string[];
  thermalData: LineplotData;
  currFrameIndex: number;
  updateFrame: (index: number) => void;
}

interface Props {
  expId: string;
  thermometers: Thermometer[];
  thermalData: LineplotData;
  currFrameIndex: number;
  updateFrame: (index: number) => void;
  unit: TemperatureUnit;
}

// The whole-frame envelope, overlaid (dashed) on the per-thermometer lines when the menu toggle is on —
// so the merged T(t) plot can show each probe against the frame's hottest / mean / coldest pixel.
const FRAME_SERIES = [
  { key: 'frameMax', name: 'Max', color: '#d64545' },
  { key: 'frameMean', name: 'Mean', color: '#888888' },
  { key: 'frameMin', name: 'Min', color: '#3b6fd4' },
] as const;

interface SeriesPoint {
  name: string;
  color: string;
  value: number;
}

// Geometry for the readout labels.
const DOT_R = 3;
const LABEL_GAP = 7; // px between the dot and the text
const LABEL_MIN_GAP = 15; // min vertical gap between two labels before they get spread out
const CHAR_PX = 6.6; // rough width of one 12px label char, for the side-flip room check

interface ReadoutGeo {
  yScale: (v: number) => number;
  bandTop: number;
  bandBottom: number;
  plotLeft: number;
  plotRight: number;
}

/**
 * Lay out one vertical readout at pixel x `px`: a dot where each series crosses the vertical, plus a
 * decluttered "<name> <value> °C" label beside it. Labels flip to whichever side has room (or the side
 * forced by the caller, used to keep the hover column clear of the playhead), and never spill outside
 * the plot band — when they can't all fit at the min gap they're distributed evenly instead.
 */
const layoutReadout = (
  px: number,
  points: SeriesPoint[],
  unit: TemperatureUnit,
  geo: ReadoutGeo,
  forcedSide?: 'left' | 'right',
) => {
  const items = points
    .map((p) => ({
      color: p.color,
      label: `${p.name} ${p.value.toFixed(1)} ${temperatureSymbol(unit)}`,
      y0: geo.yScale(p.value),
    }))
    .filter((p) => p.y0 != null && !Number.isNaN(p.y0))
    .sort((a, b) => a.y0 - b.y0);
  if (!items.length) return null;

  const estWidth = Math.max(...items.map((p) => p.label.length)) * CHAR_PX + DOT_R + LABEL_GAP + 6;
  let placeLeft: boolean;
  if (forcedSide) {
    placeLeft = forcedSide === 'left';
  } else {
    const roomRight = geo.plotRight - px;
    placeLeft = roomRight < estWidth && px - geo.plotLeft > roomRight;
  }
  const dir = placeLeft ? -1 : 1;
  const textAnchor = placeLeft ? 'end' : 'start';
  const textX = px + dir * (DOT_R + LABEL_GAP);

  // Declutter vertically: pack down to the min gap, then keep the whole stack inside the band —
  // falling back to even distribution when the packed stack is genuinely taller than the band.
  const placed = items.map((p) => ({ ...p, y: p.y0 }));
  const usable = geo.bandBottom - geo.bandTop;
  for (let i = 1; i < placed.length; i++) {
    if (placed[i].y < placed[i - 1].y + LABEL_MIN_GAP) placed[i].y = placed[i - 1].y + LABEL_MIN_GAP;
  }
  const packedSpan = placed[placed.length - 1].y - placed[0].y;
  if (packedSpan > usable) {
    const eff = placed.length > 1 && usable > 0 ? usable / (placed.length - 1) : 0;
    placed.forEach((p, i) => (p.y = geo.bandTop + i * eff));
  } else {
    const overflow = placed[placed.length - 1].y - geo.bandBottom;
    if (overflow > 0) for (const p of placed) p.y -= overflow;
    const highest = Math.min(...placed.map((p) => p.y));
    if (highest < geo.bandTop) for (const p of placed) p.y += geo.bandTop - highest;
  }

  return { px, estWidth, placeLeft, dir, textAnchor, textX, placed };
};

type Readout = NonNullable<ReturnType<typeof layoutReadout>>;

const renderReadout = (r: Readout, keyPrefix: string) => (
  <g>
    {r.placed.map((p, i) => (
      <g key={`${keyPrefix}-${i}`}>
        <circle cx={r.px} cy={p.y0} r={DOT_R} fill={p.color} stroke="#fff" strokeWidth={1} />
        {Math.abs(p.y - p.y0) > 3 && (
          <line
            x1={r.px + r.dir * DOT_R}
            y1={p.y0}
            x2={r.textX - r.dir * 2}
            y2={p.y}
            stroke={p.color}
            strokeWidth={1}
            strokeOpacity={0.5}
          />
        )}
        <text
          x={r.textX}
          y={p.y}
          textAnchor={r.textAnchor}
          dominantBaseline="central"
          fontSize={12}
          fontWeight={600}
          fill={p.color}
          stroke="#fff"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {p.label}
        </text>
      </g>
    ))}
  </g>
);

/**
 * The in-place readouts (replacing the tooltip box): an optional orange playback column, and the grey
 * mouse-hover column when present. Rendered as one recharts `<Customized>` layer so both share the
 * chart's x/y scales and can be laid out jointly — when the hover column is close enough to collide
 * with the playhead column it is pushed to the opposite side (or dropped if there's no room). The
 * `playhead`/`hover`/`unit` props are threaded in by the caller; the rest are injected by recharts.
 */
const ReadoutLabels = ({ xAxisMap, yAxisMap, offset, playhead, hover, unit }: any) => {
  if (!xAxisMap || !yAxisMap || !offset) return null;
  const xScale = xAxisMap[Object.keys(xAxisMap)[0]]?.scale;
  const yScale = yAxisMap[Object.keys(yAxisMap)[0]]?.scale;
  if (!xScale || !yScale) return null;

  const geo: ReadoutGeo = {
    yScale,
    bandTop: offset.top + 8,
    bandBottom: offset.top + offset.height - 4,
    plotLeft: offset.left,
    plotRight: offset.left + offset.width,
  };

  const boxOf = (r: Readout): [number, number] => (r.placeLeft ? [r.px - r.estWidth, r.px] : [r.px, r.px + r.estWidth]);

  const pxP = playhead?.points?.length ? xScale(playhead.atX) : null;
  const pxH = hover?.points?.length ? xScale(hover.atX) : null;

  // The mouse-hover readout is primary: always drawn on its natural side, never hidden by the playhead.
  const H: Readout | null = pxH != null && !Number.isNaN(pxH) ? layoutReadout(pxH, hover.points, unit, geo) : null;

  // The playhead readout yields to the hover one. It keeps its natural side unless their label boxes
  // would overlap, in which case it moves to a side that clears the hover box (preferring the side
  // pointing away from it) — or drops, keeping just the orange line, when neither side is clear.
  let P: Readout | null = pxP != null && !Number.isNaN(pxP) ? layoutReadout(pxP, playhead.points, unit, geo) : null;
  if (P && H) {
    const pNat = P;
    const [pl, pr] = boxOf(pNat);
    const [hL, hR] = boxOf(H);
    if (pl < hR && hL < pr) {
      const eP = pNat.estWidth;
      const rightClear = pNat.px + eP <= geo.plotRight && (pNat.px + eP <= hL || pNat.px >= hR);
      const leftClear = pNat.px - eP >= geo.plotLeft && (pNat.px <= hL || pNat.px - eP >= hR);
      const order: ('left' | 'right')[] = pNat.px >= H.px ? ['right', 'left'] : ['left', 'right'];
      const side = order.find((s) => (s === 'right' ? rightClear : leftClear));
      P = side
        ? side === (pNat.placeLeft ? 'left' : 'right')
          ? pNat
          : layoutReadout(pNat.px, playhead.points, unit, geo, side)
        : null;
    }
  }

  if (!P && !H) return null;
  // Playhead underneath, hover on top — the mouse readout is the primary one.
  return (
    <g style={{ pointerEvents: 'none' }}>
      {P && renderReadout(P, 'ph')}
      {H && renderReadout(H, 'hv')}
    </g>
  );
};

// One thermometer series' fit over the selected window: its label/colour, the fit (null when it couldn't be
// fit), and how many finite points fell in the window (to explain a null as "too few points" vs "no decay").
interface FitSeries {
  id: string;
  name: string;
  color: string;
  fit: ExpFit | null;
  points: number;
}
interface FitResult {
  lo: number; // window start (seconds) the curves + band span
  hi: number; // window end (seconds)
  perTherm: FitSeries[];
}

// Adaptive time-constant formatting: τ can be sub-second or many minutes. Keep the primary read in seconds
// (the chart's x-unit), adding a minutes hint once seconds get hard to eyeball.
const fmtTau = (s: number): string => {
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s < 1) return `${Number(s.toPrecision(2))} s`;
  if (s < 100) return `${s.toFixed(1)} s`;
  if (s < 600) return `${s.toFixed(0)} s`;
  return `${s.toFixed(0)} s (${(s / 60).toFixed(1)} min)`;
};

// The fitted cooling/heating curves, drawn as dashed SVG paths over the plot through one <Customized> layer so
// they share the chart's x/y scales. Each fit is sampled across the selected window and clipped to the plot
// area (a weakly-constrained fit can extrapolate off-band). `fits` is threaded by the caller; the scale maps
// and plot `offset` are injected by recharts.
const FIT_CLIP_ID = 'tt-fit-clip';
const FitCurves = ({ xAxisMap, yAxisMap, offset, fits }: any) => {
  if (!xAxisMap || !yAxisMap || !offset || !fits) return null;
  const xScale = xAxisMap[Object.keys(xAxisMap)[0]]?.scale;
  const yScale = yAxisMap[Object.keys(yAxisMap)[0]]?.scale;
  if (!xScale || !yScale) return null;
  return (
    <g style={{ pointerEvents: 'none' }}>
      <defs>
        <clipPath id={FIT_CLIP_ID}>
          <rect x={offset.left} y={offset.top} width={offset.width} height={offset.height} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${FIT_CLIP_ID})`}>
        {(fits.perTherm as FitSeries[]).map((p) => {
          if (!p.fit) return null;
          const pts = sampleExpFit(p.fit, fits.lo, fits.hi, 64);
          const d = pts
            .map((q, i) => `${i === 0 ? 'M' : 'L'}${xScale(q.t).toFixed(1)},${yScale(q.T).toFixed(1)}`)
            .join(' ');
          return (
            <path key={p.id} d={d} fill="none" stroke={p.color} strokeWidth={2.5} strokeDasharray="7 4" opacity={0.9} />
          );
        })}
      </g>
    </g>
  );
};

const Wrapper = ({ expId, thermometersId, thermalData, currFrameIndex, updateFrame }: WrapperProps) => {
  const thermometerMap = useCommonStore((state) => state.thermometerMap);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const thermometers = thermometersId.map((id) => thermometerMap.get(id)).filter((v) => v !== undefined);
  return (
    <LinePlot
      expId={expId}
      thermometers={thermometers}
      thermalData={thermalData}
      currFrameIndex={currFrameIndex}
      updateFrame={updateFrame}
      unit={temperatureUnit}
    />
  );
};

const LinePlot = React.memo(
  ({ expId, thermometers, thermalData, currFrameIndex, updateFrame, unit }: Props) => {
    const [data, setData] = useState<any>(null);
    // Data index the mouse is currently over — drives the grey hover line + its live value labels.
    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    // When a thermometer is hovered in the image, dim every other line so its series stands out.
    const hoveredId = useCommonStore((state) => state.hoveredThermometerId);

    // telelab-style chart display options, controlled from the chart menu. Stored on the experiment
    // (per-experiment, like graphsOptions), falling back to the defaults until first edited; the owner's
    // edits auto-save. Reading them here also survives the workspace unmounting the chart on a mode switch.
    const { lineWidth, symbolCount, symbolSize, horizontalGrid, verticalGrid, frameStats } = useCommonStore(
      (state) => state.experimentMap.get(expId)?.chartSettings?.line ?? DEFAULT_LINE_CHART_SETTINGS,
    );
    const setLine = useCommonStore((state) => state.setLineChartSetting);
    const patch = (p: Partial<LineChartSettings>) => setLine(expId, p);
    // Maximize / restore this chart to fill the Charts panel (session-only).
    const maximizedChart = useCommonStore((state) => state.maximizedChart);
    const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
    const maximized = maximizedChart === ExperimentGraphOption.time;
    const setLineWidth = (v: number) => patch({ lineWidth: v });
    const setSymbolCount = (v: number) => patch({ symbolCount: v });
    const setSymbolSize = (v: number) => patch({ symbolSize: v });
    const setHorizontalGrid = (v: boolean) => patch({ horizontalGrid: v });
    const setVerticalGrid = (v: boolean) => patch({ verticalGrid: v });
    const setFrameStats = (v: boolean) => patch({ frameStats: v });

    // Cooling/heating curve-fit tool: drag-select a time window and fit an exponential per thermometer. Mode +
    // window are transient store state (survive a maximize, cleared on leave), mirroring the T(l) gradient tool.
    const fitMode = useCommonStore((state) => state.timeFitMode);
    const setFitMode = useCommonStore((state) => state.setTimeFitMode);
    const fitRange = useCommonStore((state) => state.timeFitRange);
    const setFitRange = useCommonStore((state) => state.setTimeFitRange);
    // Time (seconds) where the current drag-select started; a ref so a drag doesn't re-render. Null = not dragging.
    const fitDragStartRef = useRef<number | null>(null);

    const init = async () => {
      const data: any = [];
      thermalData.arrayBuffer.forEach((arrayBuffer, index) => {
        const frameData = { time: Number((index * thermalData.step * thermalData.secondPerFrame).toFixed(1)) } as any;
        thermometers.forEach((thermometer, index) => {
          frameData[`T${index + 1}`] = displayTemp(getThermometerValue(arrayBuffer, thermometer), unit);
        });
        // Whole-frame envelope (max/mean/min), built only when the toggle is on so the frame keys — and
        // thus the Y-axis domain — carry only what's actually drawn. A truncated frame drops to a gap
        // (null) so the -273.15 sentinel never plots. The decode is cached, so this is cheap.
        if (frameStats) {
          try {
            const { min, max, mean, complete } = getDecodedFrame(arrayBuffer);
            frameData.frameMax = complete ? displayTemp(max, unit) : null;
            frameData.frameMean = complete ? displayTemp(mean, unit) : null;
            frameData.frameMin = complete ? displayTemp(min, unit) : null;
          } catch {
            frameData.frameMax = frameData.frameMean = frameData.frameMin = null;
          }
        }
        data.push(frameData);
      });
      setData(data);
    };

    useEffect(() => {
      init();
    }, [thermometers, thermalData, unit, frameStats]);

    // The data row at (or just before) the current frame time — positions the orange playhead line.
    let refIndex = 0;
    if (data?.length) {
      const idx = data.findIndex((d: any) => currFrameIndex * thermalData.secondPerFrame < d.time);
      refIndex = idx === -1 ? data.length - 1 : Math.max(0, idx - 1);
    }
    const refRow = data?.length ? data[refIndex] : null;
    const refX = refRow ? refRow.time : 0;

    // One label per drawn series (thermometer lines then the frame envelope), carrying its name +
    // colour + value in a given row — the per-series points for the hover readout.
    const pointsForRow = (row: any): { name: string; color: string; value: number }[] => {
      const out: { name: string; color: string; value: number }[] = [];
      if (!row) return out;
      thermometers.forEach((t, i) => {
        const v = row[`T${i + 1}`];
        if (typeof v === 'number' && Number.isFinite(v)) {
          out.push({ name: t.name?.trim() || `T${i + 1}`, color: PRESET_COLORS[i % PRESET_COLORS.length], value: v });
        }
      });
      if (frameStats) {
        FRAME_SERIES.forEach((s) => {
          const v = row[s.key];
          if (typeof v === 'number' && Number.isFinite(v)) out.push({ name: s.name, color: s.color, value: v });
        });
      }
      return out;
    };
    // The row the mouse is over — its own grey vertical line + live value labels.
    const hoverRow = hoverIndex != null && data?.length ? data[hoverIndex] : null;
    const hoverX = hoverRow ? hoverRow.time : null;
    const hoverPoints = pointsForRow(hoverRow);

    // Evenly-spaced, round-numbered ticks across the full time range (~9 intervals).
    const maxTime = data?.length ? data[data.length - 1].time : 0;
    const niceStep = (() => {
      const raw = maxTime / 9 || 1;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / mag;
      const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
      return step * mag;
    })();
    const xTicks: number[] = [];
    for (let t = 0; t <= maxTime + 1e-9; t += niceStep) xTicks.push(Number(t.toFixed(2)));

    // Round, evenly-spaced temperature ticks that hug the actual readings so the lines fill the plot
    // instead of floating in a fixed band. Scan every drawn series (T1…Tn, plus the frame envelope when
    // it's on); null gaps from truncated frames are skipped. Matches the T(x)/T(y)/T(l) charts.
    let yMin = Infinity;
    let yMax = -Infinity;
    if (data) {
      for (const row of data) {
        for (const key in row) {
          if (key === 'time') continue;
          const v = row[key];
          if (typeof v === 'number' && Number.isFinite(v)) {
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
          }
        }
      }
    }
    const yAxis = niceTemperatureAxis(yMin, yMax);

    // Show roughly `symbolCount` evenly-spaced symbols along each line (0 = no symbols).
    const dotInterval = symbolCount > 0 && data?.length ? Math.max(1, Math.round(data.length / symbolCount)) : 0;
    const renderDot = (color: string, opacity: number) => (props: any) => {
      const { cx, cy, index } = props;
      if (!dotInterval || index % dotInterval !== 0 || cx == null || cy == null) return <g key={`dot-${index}`} />;
      return <circle key={`dot-${index}`} cx={cx} cy={cy} r={symbolSize} fill={color} opacity={opacity} />;
    };

    // Clamp a recharts activeLabel (the time under the cursor) into [0, maxTime], or null off the plot area.
    const clampTime = (raw: unknown): number | null => {
      const t = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(t) ? Math.min(maxTime, Math.max(0, t)) : null;
    };

    // Per-thermometer exponential fit over the selected window (whole clip when nothing is dragged). Keyed on
    // the sampled series + window + thermometer set, so it recomputes on a drag / add / delete — not on every
    // playback frame (the fit is over the window, not the current frame). Reads the already-built `data` rows,
    // whose temperatures are in the display unit, so τ comes out in seconds and T∞ in the shown unit.
    const thermoKey = thermometers.map((t, i) => `${t.id}:${t.name ?? ''}:${i}`).join('|');
    const fits: FitResult | null = useMemo(() => {
      if (!fitMode || !data?.length || thermometers.length === 0) return null;
      const fullHi = data[data.length - 1].time;
      const lo = fitRange ? Math.min(fitRange[0], fitRange[1]) : 0;
      const hi = fitRange ? Math.max(fitRange[0], fitRange[1]) : fullHi;
      const inRange = data.filter((r: any) => r.time >= lo - 1e-9 && r.time <= hi + 1e-9);
      const perTherm: FitSeries[] = thermometers.map((t, i) => {
        const key = `T${i + 1}`;
        const pts = inRange
          .map((r: any) => ({ t: r.time as number, T: r[key] as number }))
          .filter((p: { t: number; T: number }) => typeof p.T === 'number' && Number.isFinite(p.T));
        return {
          id: t.id,
          name: t.name?.trim() || `T${i + 1}`,
          color: PRESET_COLORS[i % PRESET_COLORS.length],
          fit: fitNewtonCooling(pts),
          points: pts.length,
        };
      });
      return { lo, hi, perTherm };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, fitMode, fitRange, thermoKey]);

    const unitSym = temperatureSymbol(unit);
    // Fit readout — a strip BELOW the plot (like the T(l) gradient panel), so it never covers the curves; the
    // plot shrinks to make room. One entry per thermometer: τ, T∞, R², and cool/heat. Part of the
    // chart-container, so it's included in the PNG export. Only shown while the tool is armed (which maximizes
    // the chart), so there's room for it.
    const fitPanel = fitMode ? (
      <div
        className="time-fit-readout"
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          flex: '0 0 auto',
          maxHeight: '46%',
          overflow: 'auto',
          borderTop: '1px solid #e6e6e6',
          padding: '5px 8px 6px',
          fontSize: 12,
          lineHeight: 1.45,
          color: '#222',
        }}
      >
        <div style={{ marginBottom: 3 }}>
          <span style={{ fontWeight: 700 }}>Cooling / heating fit</span>
          <span style={{ color: '#999', marginLeft: 8, fontSize: 11 }}>
            T = T∞ + (T₀−T∞)·e^(−t/τ) · drag to select a time window (click to reset)
          </span>
        </div>
        {fits && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, rowGap: 3 }}>
            {fits.perTherm.map((p) => (
              <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, flex: '0 0 auto' }} />
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                {p.fit ? (
                  <>
                    <span
                      style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}
                    >{`τ ${fmtTau(p.fit.tau)}`}</span>
                    <span
                      style={{ color: '#555', fontVariantNumeric: 'tabular-nums' }}
                    >{`T∞ ${p.fit.tInf.toFixed(1)}${unitSym}`}</span>
                    <span style={{ color: '#999' }}>{`R² ${p.fit.r2.toFixed(2)}`}</span>
                    <span style={{ color: '#888', fontSize: 11 }}>
                      {p.fit.direction === 'heating' ? 'heat' : 'cool'}
                    </span>
                  </>
                ) : (
                  <span style={{ color: '#c0392b' }}>
                    {p.points < MIN_FIT_POINTS ? 'too few points in window' : 'no clear curve'}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    ) : null;

    return (
      <div
        className="chart-container"
        // Flex column so the fit readout strip can sit below the plot (and the plot shrink to make room), like
        // the T(l) profile chart. userSelect none while the fit tool is armed keeps a drag from text-selecting
        // the axis labels / readout strip as it sweeps.
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          userSelect: fitMode ? 'none' : undefined,
        }}
        ref={containerRef}
      >
        {data && (
          <ChartMenu
            onSavePNG={() =>
              containerRef.current && exportElementToPNG(containerRef.current, timestampedName('lineplot', 'png'))
            }
            onExportCSV={() => downloadCSV(timestampedName('temperature-time', 'csv'), data)}
            maximized={maximized}
            onToggleMaximize={() => setMaximizedChart(maximized ? null : ExperimentGraphOption.time)}
            fitActive={fitMode}
            onToggleFit={() => setFitMode(!fitMode)}
            controls={{
              lineWidth,
              onLineWidth: setLineWidth,
              symbolCount,
              symbolCountMax: Math.min(50, data.length),
              onSymbolCount: setSymbolCount,
              symbolSize,
              onSymbolSize: setSymbolSize,
              horizontalGrid,
              onHorizontalGrid: setHorizontalGrid,
              verticalGrid,
              onVerticalGrid: setVerticalGrid,
              frameStats,
              onFrameStats: setFrameStats,
            }}
          />
        )}
        <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
          <ResponsiveContainer width="100%" height={'100%'}>
            <LineChart
              width={500}
              height={300}
              data={data}
              margin={CHART_MARGIN}
              // Crosshair while the fit tool is armed — the cue that the chart is drag-selectable (same
              // affordance as the T(l) gradient tool). Goes through recharts' style prop, which its wrapper
              // honours over the default cursor.
              style={{ cursor: fitMode ? 'crosshair' : undefined }}
              onMouseDown={(s: any, e?: { preventDefault?: () => void }) => {
                // In fit mode a press-drag defines the fit window; otherwise a plain press seeks the playhead.
                if (fitMode) {
                  const t = clampTime(s?.activeLabel);
                  if (t == null) return;
                  // Stop the browser starting a native text selection from this press as the drag sweeps.
                  e?.preventDefault?.();
                  fitDragStartRef.current = t;
                  setFitRange([t, t]);
                  return;
                }
                if (s?.activeLabel) {
                  updateFrame(Math.floor(Number(s.activeLabel) / thermalData.secondPerFrame));
                }
              }}
              onMouseMove={(s: any) => {
                const i = s?.activeTooltipIndex;
                setHoverIndex(typeof i === 'number' && i >= 0 ? i : null);
                if (fitMode && fitDragStartRef.current != null) {
                  const t = clampTime(s?.activeLabel);
                  if (t != null) setFitRange([fitDragStartRef.current, t]);
                }
              }}
              onMouseUp={(s: any) => {
                if (fitDragStartRef.current == null) return;
                const start = fitDragStartRef.current;
                fitDragStartRef.current = null;
                const end = clampTime(s?.activeLabel) ?? start;
                // Too short a drag reads as a click → reset to the whole-clip fit; otherwise commit the window.
                if (Math.abs(end - start) < maxTime * 0.02) setFitRange(null);
                else setFitRange([Math.min(start, end), Math.max(start, end)]);
              }}
              onMouseLeave={() => {
                setHoverIndex(null);
                fitDragStartRef.current = null; // end any in-progress drag; the last committed window stays
              }}
            >
              <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />

              {/* Selection band for the fit window, behind the curves. Skipped at the whole-clip default
                  (fitRange null) — a wash over the whole plot marks nothing; it appears once a drag narrows it. */}
              {fitMode && fitRange && fits && (
                <ReferenceArea
                  x1={fits.lo}
                  x2={fits.hi}
                  fill="rgba(19,124,124,0.12)"
                  stroke="rgba(19,124,124,0.55)"
                  strokeDasharray="3 3"
                  ifOverflow="extendDomain"
                />
              )}

              <XAxis dataKey="time" type="number" domain={[0, maxTime]} ticks={xTicks} allowDecimals={false}>
                <Label value={'Time (Second)'} offset={-5} position="bottom" />
              </XAxis>

              {/* Domain hugs the true data range so the lines fill the plot instead of floating below a
                near-empty top band. */}
              <YAxis
                type="number"
                domain={yAxis ? yAxis.domain : ['auto', 'auto']}
                ticks={yAxis?.ticks}
                width={Y_AXIS_WIDTH}
                padding={{ top: 12, bottom: 12 }}
                tickFormatter={yTickFormatter(yAxis?.ticks)}
              >
                <Label content={renderYAxisTitle(`T (${temperatureSymbol(unit)})`)} />
              </YAxis>

              {/* No in-plot legend: the colour↔thermometer key is shared across T(t)/T(x)/T(y) and shown
                once above the grid (chartColorKey) so a wrapped legend can't eat this short plot's height. */}

              {/* Grey line the mouse follows, with live per-line values; drawn under the orange playhead. */}
              {hoverX != null && <ReferenceLine x={hoverX} stroke="#8c8c8c" strokeWidth={1} />}
              <ReferenceLine x={refX} stroke="orange" strokeWidth={2} />

              {data &&
                thermometers.map((value, i) => {
                  const color = PRESET_COLORS[i % PRESET_COLORS.length];
                  const emphasized = hoveredId != null && value.id === hoveredId;
                  const opacity = hoveredId != null && !emphasized ? 0.2 : 1;
                  return (
                    <Line
                      key={i}
                      type="monotone"
                      // dataKey stays the stable positional key (matches the frame data built above);
                      // `name` is the display label (user-given name or the "T1"… default) the tooltip shows.
                      dataKey={`T${i + 1}`}
                      name={value.name?.trim() || `T${i + 1}`}
                      stroke={color}
                      strokeWidth={emphasized ? lineWidth + 1 : lineWidth}
                      strokeOpacity={opacity}
                      dot={dotInterval ? renderDot(color, opacity) : false}
                      isAnimationActive={false}
                    />
                  );
                })}

              {data &&
                frameStats &&
                FRAME_SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.name}
                    // The frame envelope isn't a thermometer, so it's absent from the shared colour key; its
                    // dashed lines are identified by their in-place value labels.
                    stroke={s.color}
                    strokeWidth={lineWidth}
                    strokeDasharray="5 4"
                    strokeOpacity={hoveredId != null ? 0.2 : 1}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}

              {/* Fitted cooling/heating curves over the selected window, dashed, above the data lines and below
                the hover readouts. Drawn via a Customized SVG layer so a smooth exponential (not a polyline
                through data points) can be sampled and clipped to the plot. */}
              {data && fits && <Customized component={(rc: any) => <FitCurves {...rc} fits={fits} />} />}

              {/* In-place readout for the mouse-hover column (replaces the tooltip box). The orange
                playhead intentionally carries no readout — only its line is drawn — so the chart stays
                uncluttered at rest. Rendered last so it sits above every line; pointer-events are off
                so click-to-seek still reaches the chart. */}
              {data && hoverPoints.length > 0 && (
                <Customized
                  component={(rc: any) => (
                    <ReadoutLabels
                      {...rc}
                      playhead={null}
                      hover={hoverX != null ? { atX: hoverX, points: hoverPoints } : null}
                      unit={unit}
                    />
                  )}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
        {fitPanel}
      </div>
    );
  },
  (prev, next) => {
    if (prev.unit !== next.unit) return false;
    if (prev.currFrameIndex !== next.currFrameIndex) return false;
    if (prev.thermalData !== next.thermalData) return false;
    if (prev.thermometers.length !== next.thermometers.length) return false;
    for (let i = 0; i < prev.thermometers.length; i++) {
      const pt = prev.thermometers[i];
      const nt = next.thermometers[i];
      // `name` drives the series label, so a rename must re-render to refresh the tooltip.
      if (pt.x !== nt.x || pt.y !== nt.y || pt.name !== nt.name) return false;
    }
    return true;
  },
);

export default Wrapper;
