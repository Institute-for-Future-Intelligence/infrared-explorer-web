import {
  CartesianGrid,
  ErrorBar,
  Label,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useMemo, useRef } from 'react';
import useCommonStore, { DEFAULT_SCATTER_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, LineplotData, ScatterChartSettings } from '../../../types';
import { CHART_MARGIN, PRESET_COLORS } from '../../../utils/constants';
import { displayTemp, niceTemperatureTicks, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { getThermometerValue } from '../../../utils/temperatureReader';
import ChartMenu from './chartMenu';
import { renderYAxisTitle } from './chartLabels';

interface Props {
  expId: string;
  type: 'X' | 'Y';
  thermometersId: string[];
  thermalData: LineplotData | null;
}

/** Population standard deviation, matching telelab's error-bar metric. */
const stdDev = (values: number[]) => {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
};

// Distinct symbol per thermometer (cycles), coloured by PRESET_COLORS — telelab's per-series shapes.
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross'] as const;

const renderSymbol = (props: { cx?: number; cy?: number; payload?: { i?: number; dimmed?: boolean } }) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return <g />;
  const i = payload?.i ?? 0;
  const color = PRESET_COLORS[i % PRESET_COLORS.length];
  const s = 5;
  // Dimmed when another thermometer is hovered, so the hovered one's symbol stands out.
  const opacity = payload?.dimmed ? 0.2 : 1;
  let shape: JSX.Element;
  switch (SHAPES[i % SHAPES.length]) {
    case 'square':
      shape = <rect x={cx - s} y={cy - s} width={2 * s} height={2 * s} fill={color} />;
      break;
    case 'triangle':
      shape = <polygon points={`${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}`} fill={color} />;
      break;
    case 'diamond':
      shape = <polygon points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`} fill={color} />;
      break;
    case 'cross':
      shape = (
        <g stroke={color} strokeWidth={2}>
          <line x1={cx - s} y1={cy} x2={cx + s} y2={cy} />
          <line x1={cx} y1={cy - s} x2={cx} y2={cy + s} />
        </g>
      );
      break;
    default:
      shape = <circle cx={cx} cy={cy} r={s} fill={color} />;
  }
  return <g opacity={opacity}>{shape}</g>;
};

/**
 * Evenly-spaced "nice" tick values for the temperature axis: the step is rounded to a
 * 1/2/5×10ⁿ value with a 0.1 floor, so the 1-decimal tick labels stay distinct. (Letting
 * recharts evenly divide a tiny data range gives non-round ticks that collapse to duplicate
 * labels once rounded — e.g. 21.755 and 21.85 both show as 21.8.)
 */
interface ScatterPoint {
  x: number;
  y: number;
  i: number;
  dimmed: boolean;
  error: number;
  name: string; // thermometer label shown in the tooltip
}

// Custom tooltip so each hovered point names its thermometer (recharts' default scatter tooltip
// only lists the x/y values). Styled to match recharts' default tooltip box.
const ScatterTooltip = ({
  active,
  payload,
  unit,
  type,
}: {
  active?: boolean;
  payload?: { payload: ScatterPoint }[];
  unit: string;
  type: 'X' | 'Y';
}) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #ccc',
        padding: '8px 10px',
        whiteSpace: 'nowrap',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{p.name}</div>
      <div>{`${type}: ${p.x.toFixed(3)}`}</div>
      <div>{`T: ${p.y.toFixed(2)}${unit}`}</div>
    </div>
  );
};

const ScatterPlot = ({ expId, thermometersId, type, thermalData }: Props) => {
  const thermometerMap = useCommonStore((state) => state.thermometerMap);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  // When a thermometer is hovered in the image, dim the connecting line and the other symbols.
  const hoveredId = useCommonStore((state) => state.hoveredThermometerId);
  const containerRef = useRef<HTMLDivElement>(null);

  // telelab-style chart display options, controlled from the chart menu. Stored on the experiment
  // (per-experiment, like graphsOptions), falling back to the defaults until first edited; the owner's
  // edits auto-save. X and Y scatters share the one scatter plane — a display preference reads the same
  // for both. Reading them here also survives the workspace unmounting the chart on a mode switch.
  const { lineWidth, errorBars, horizontalGrid, verticalGrid } = useCommonStore(
    (state) => state.experimentMap.get(expId)?.chartSettings?.scatter ?? DEFAULT_SCATTER_CHART_SETTINGS,
  );
  const setScatter = useCommonStore((state) => state.setScatterChartSetting);
  const patch = (p: Partial<ScatterChartSettings>) => setScatter(expId, p);
  // Maximize / restore this chart to fill the Charts panel (session-only).
  const maximizedChart = useCommonStore((state) => state.maximizedChart);
  const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
  const chartKey = type === 'X' ? ExperimentGraphOption.spaceX : ExperimentGraphOption.spaceY;
  const maximized = maximizedChart === chartKey;
  const setLineWidth = (v: number) => patch({ lineWidth: v });
  const setErrorBars = (v: boolean) => patch({ errorBars: v });
  const setHorizontalGrid = (v: boolean) => patch({ horizontalGrid: v });
  const setVerticalGrid = (v: boolean) => patch({ verticalGrid: v });

  // Error bar = std dev of each thermometer's temperature across all frames (telelab parity).
  // Keyed on positions/unit (not the per-frame `value`) so playback doesn't trigger a recompute.
  const positionsKey = thermometersId
    .map((id) => {
      const t = thermometerMap.get(id);
      return t ? `${id}:${t.x},${t.y},${t.measuringAreaType},${t.measuringAreaWidth},${t.measuringAreaHeight}` : id;
    })
    .join('|');
  // Per-thermometer std dev plus the global temperature range across ALL frames. Computing the
  // Y-axis domain from the full playback (not the current frame's values) keeps the temperature
  // axis fixed during playback instead of rescaling frame-to-frame.
  const { stdDevById, tempRange } = useMemo(() => {
    const map = new Map<string, number>();
    let min = Infinity;
    let max = -Infinity;
    if (!thermalData) return { stdDevById: map, tempRange: null as [number, number] | null };
    thermometersId.forEach((id) => {
      const thermometer = thermometerMap.get(id);
      if (!thermometer) return;
      const temps = thermalData.arrayBuffer.map((buf) =>
        displayTemp(getThermometerValue(buf, thermometer), temperatureUnit),
      );
      map.set(id, stdDev(temps));
      temps.forEach((t) => {
        if (t < min) min = t;
        if (t > max) max = t;
      });
    });
    const tempRange: [number, number] | null = Number.isFinite(min) ? [min, max] : null;
    return { stdDevById: map, tempRange };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermalData, temperatureUnit, positionsKey]);

  const data: ScatterPoint[] = thermometersId
    .map((id, i) => {
      const thermometer = thermometerMap.get(id);
      const dimmed = hoveredId != null && id !== hoveredId;
      // Per-point label for the tooltip: user-given name, or the positional default ("T1", "T2", …).
      const name = thermometer?.name?.trim() || `T${i + 1}`;
      if (!thermometer) return { x: -1, y: 0, i, dimmed, error: 0, name };
      const y = displayTemp(thermometer.value ?? 0, temperatureUnit); // showcase thermometer may lack an initial value
      const error = stdDevById.get(id) ?? 0;
      if (type === 'X') {
        return { x: thermometer.x, y, i, dimmed, error, name };
      } else {
        return { x: 1 - thermometer.y, y, i, dimmed, error, name };
      }
    })
    .filter((d) => d.x !== -1);

  const unit = temperatureSymbol(temperatureUnit);
  const labelText = type === 'X' ? 'Width' : 'Height';

  // Round, evenly-spaced ticks so the 1-decimal labels read cleanly (no duplicates).
  // Use the temperature range across all frames so the axis stays fixed during playback;
  // fall back to the current-frame values if the full range isn't available.
  const yValues = data.map((d) => d.y);
  const [yMin, yMax] = tempRange ?? [Math.min(...yValues), Math.max(...yValues)];
  const yTicks = niceTemperatureTicks(yMin, yMax);

  const exportCSV = () =>
    downloadCSV(
      timestampedName(`temperature-${type === 'X' ? 'x' : 'y'}`, 'csv'),
      data.map((d) => ({ position: d.x, [`T (${unit})`]: d.y })),
    );

  return (
    <div className="chart-container" style={{ position: 'relative' }} ref={containerRef}>
      {data.length > 0 && (
        <ChartMenu
          onSavePNG={() =>
            containerRef.current && exportElementToPNG(containerRef.current, timestampedName(`scatter-${type}`, 'png'))
          }
          onExportCSV={exportCSV}
          maximized={maximized}
          onToggleMaximize={() => setMaximizedChart(maximized ? null : chartKey)}
          controls={{
            lineWidth,
            onLineWidth: setLineWidth,
            errorBars,
            onErrorBars: setErrorBars,
            horizontalGrid,
            onHorizontalGrid: setHorizontalGrid,
            verticalGrid,
            onVerticalGrid: setVerticalGrid,
          }}
        />
      )}
      <ResponsiveContainer width="100%" height={'100%'}>
        <ScatterChart margin={CHART_MARGIN}>
          <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />

          <XAxis dataKey="x" name="X" type="number" domain={[0, 1]} allowDataOverflow={true}>
            <Label value={`${type} (Image ${labelText})`} offset={-5} position="bottom" />
          </XAxis>
          {/* Round tick labels to 1 decimal: the raw values carry 3 decimals (e.g. 21.945),
              which would crowd the rotated axis title. width matches the line plot so all
              three charts line up. */}
          <YAxis
            dataKey="y"
            name="T"
            type="number"
            domain={yTicks ? [yTicks[0], yTicks[yTicks.length - 1]] : ['auto', 'auto']}
            ticks={yTicks}
            width={72}
            padding={{ top: 12, bottom: 12 }}
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label content={renderYAxisTitle(`T (${unit})`)} />
          </YAxis>

          <Tooltip content={<ScatterTooltip unit={unit} type={type} />} />

          <Scatter
            isAnimationActive={false}
            data={data}
            line={{ stroke: '#888', strokeWidth: lineWidth, strokeOpacity: hoveredId != null ? 0.2 : 1 }}
            shape={renderSymbol}
          >
            {errorBars && <ErrorBar dataKey="error" direction="y" width={4} strokeWidth={1} stroke="#888" />}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ScatterPlot;
