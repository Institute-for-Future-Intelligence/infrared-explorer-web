import {
  CartesianGrid,
  Customized,
  Label,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MARGIN, PRESET_COLORS } from '../../../utils/constants';
import useCommonStore, { DEFAULT_LINE_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, LineChartSettings, LineplotData, TemperatureUnit, Thermometer } from '../../../types';
import React, { useEffect, useRef, useState } from 'react';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { displayTemp, niceTemperatureAxis, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import ChartMenu from './chartMenu';
import { renderYAxisTitle } from './chartLabels';

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

/**
 * In-place value readout along a vertical line at time `atX` — used both for the orange playback line
 * and the grey mouse-hover line. Instead of a floating tooltip box (which covers a large slice of the
 * plot), each drawn series gets a small dot where its curve crosses the vertical, plus "<name> <value>"
 * in the line's own colour beside it. Rendered as a recharts `<Customized>` layer so it can use the
 * chart's own x/y scales; `unit`/`atX`/`points` are threaded in by the caller, the rest (`xAxisMap`,
 * `yAxisMap`, `offset`) are injected by recharts.
 */
const IntersectionLabels = ({ xAxisMap, yAxisMap, offset, atX, points, unit }: any) => {
  if (!xAxisMap || !yAxisMap || !offset || !points?.length) return null;
  const xScale = xAxisMap[Object.keys(xAxisMap)[0]]?.scale;
  const yScale = yAxisMap[Object.keys(yAxisMap)[0]]?.scale;
  if (!xScale || !yScale) return null;

  const px = xScale(atX);
  if (px == null || Number.isNaN(px)) return null;

  // The band the labels must stay inside (a little inset from the plot edges).
  const bandTop = offset.top + 8;
  const bandBottom = offset.top + offset.height - 4;
  const dotR = 3;
  const gap = 7;
  const minGap = 15;

  // Each series' "<name> <value> °C" label, anchored to its curve; sorted top-to-bottom.
  const items = (points as SeriesPoint[])
    .map((p) => ({
      color: p.color,
      label: `${p.name} ${p.value.toFixed(1)} ${temperatureSymbol(unit)}`,
      y0: yScale(p.value) as number,
    }))
    .filter((p) => p.y0 != null && !Number.isNaN(p.y0))
    .sort((a, b) => a.y0 - b.y0);
  if (!items.length) return null;

  // Flip to whichever side of the vertical fits the widest label (est. ~6.6px/char at 12px), so the
  // now name-prefixed labels don't spill off the right edge near the end of the recording.
  const estWidth = Math.max(...items.map((p) => p.label.length)) * 6.6 + dotR + gap + 6;
  const roomRight = offset.left + offset.width - px;
  const placeLeft = roomRight < estWidth && px - offset.left > roomRight;
  const dir = placeLeft ? -1 : 1;
  const textAnchor = placeLeft ? 'end' : 'start';
  const textX = px + dir * (dotR + gap);

  // Declutter vertically.
  const placed = items.map((p) => ({ ...p, y: p.y0 }));
  const usable = bandBottom - bandTop;
  if (placed.length > 1 && (placed.length - 1) * minGap > usable) {
    // Too many labels to honour the min gap in the available height — distribute them evenly across
    // the band (accepting a tighter gap) so none spill off the bottom.
    const eff = usable > 0 ? usable / (placed.length - 1) : 0;
    placed.forEach((p, i) => (p.y = bandTop + i * eff));
  } else {
    // Enforce the min gap by nudging down, then slide the whole stack back inside the band.
    for (let i = 1; i < placed.length; i++) {
      if (placed[i].y < placed[i - 1].y + minGap) placed[i].y = placed[i - 1].y + minGap;
    }
    const overflow = placed[placed.length - 1].y - bandBottom;
    if (overflow > 0) for (const p of placed) p.y -= overflow;
    const highest = Math.min(...placed.map((p) => p.y));
    if (highest < bandTop) for (const p of placed) p.y += bandTop - highest;
  }

  return (
    <g style={{ pointerEvents: 'none' }}>
      {placed.map((p, i) => (
        <g key={i}>
          <circle cx={px} cy={p.y0} r={dotR} fill={p.color} stroke="#fff" strokeWidth={1} />
          {Math.abs(p.y - p.y0) > 3 && (
            <line
              x1={px + dir * dotR}
              y1={p.y0}
              x2={textX - dir * 2}
              y2={p.y}
              stroke={p.color}
              strokeWidth={1}
              strokeOpacity={0.5}
            />
          )}
          <text
            x={textX}
            y={p.y}
            textAnchor={textAnchor}
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

    // The data row at (or just before) the current frame time — drives both the orange playhead line
    // and the in-place value labels that replaced the tooltip box.
    let refIndex = 0;
    if (data?.length) {
      const idx = data.findIndex((d: any) => currFrameIndex * thermalData.secondPerFrame < d.time);
      refIndex = idx === -1 ? data.length - 1 : Math.max(0, idx - 1);
    }
    const refRow = data?.length ? data[refIndex] : null;
    const refX = refRow ? refRow.time : 0;

    // One label per drawn series (thermometer lines then the frame envelope), carrying its name +
    // colour + value in a given row — shared by the playhead and the hover readouts.
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
    const labelPoints = pointsForRow(refRow);

    // The row the mouse is over — its own grey vertical line + live labels. Suppressed when it lands
    // on the playhead frame (the orange labels already read that column, so don't double-draw).
    const hoverRow = hoverIndex != null && data?.length && hoverIndex !== refIndex ? data[hoverIndex] : null;
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

    return (
      <div className="chart-container" style={{ position: 'relative' }} ref={containerRef}>
        {data && (
          <ChartMenu
            onSavePNG={() =>
              containerRef.current && exportElementToPNG(containerRef.current, timestampedName('lineplot', 'png'))
            }
            onExportCSV={() => downloadCSV(timestampedName('temperature-time', 'csv'), data)}
            maximized={maximized}
            onToggleMaximize={() => setMaximizedChart(maximized ? null : ExperimentGraphOption.time)}
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
        <ResponsiveContainer width="100%" height={'100%'}>
          <LineChart
            width={500}
            height={300}
            data={data}
            margin={CHART_MARGIN}
            onMouseDown={(data) => {
              if (data.activeLabel) {
                updateFrame(Math.floor(Number(data.activeLabel) / thermalData.secondPerFrame));
              }
            }}
            onMouseMove={(s: any) => {
              const i = s?.activeTooltipIndex;
              setHoverIndex(typeof i === 'number' && i >= 0 ? i : null);
            }}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />

            <XAxis dataKey="time" type="number" domain={[0, maxTime]} ticks={xTicks} allowDecimals={false}>
              <Label value={'Time (Second)'} offset={-5} position="bottom" />
            </XAxis>

            {/* Domain hugs the true data range so the lines fill the plot instead of floating below a
                near-empty top band; width matches the scatter plots so all three charts' plot areas line up. */}
            <YAxis
              type="number"
              domain={yAxis ? yAxis.domain : ['auto', 'auto']}
              ticks={yAxis?.ticks}
              width={72}
              padding={{ top: 12, bottom: 12 }}
              tickFormatter={(v: number) => v.toFixed(1)}
            >
              <Label content={renderYAxisTitle(`T (${temperatureSymbol(unit)})`)} />
            </YAxis>

            {/* Colour key: which line is which thermometer (the frame envelope is excluded, below). */}
            {data && thermometers.length > 0 && <Legend verticalAlign="top" height={26} iconType="plainline" />}

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
                  // The frame envelope isn't a thermometer, so keep it out of the colour key; its
                  // dashed lines are still identified by their in-place value labels.
                  legendType="none"
                  stroke={s.color}
                  strokeWidth={lineWidth}
                  strokeDasharray="5 4"
                  strokeOpacity={hoveredId != null ? 0.2 : 1}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}

            {/* In-place readouts (replace the tooltip box). Rendered last so they sit above every line;
                pointer-events are off so click-to-seek still reaches the chart. Hover first, playhead
                on top. */}
            {data && hoverPoints.length > 0 && hoverX != null && (
              <Customized
                component={(rc: any) => <IntersectionLabels {...rc} atX={hoverX} points={hoverPoints} unit={unit} />}
              />
            )}
            {data && labelPoints.length > 0 && (
              <Customized
                component={(rc: any) => <IntersectionLabels {...rc} atX={refX} points={labelPoints} unit={unit} />}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
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
