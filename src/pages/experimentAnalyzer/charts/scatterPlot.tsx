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
import { useMemo, useRef, useState } from 'react';
import useCommonStore from '../../../stores/common';
import { LineplotData } from '../../../types';
import { CHART_MARGIN, PRESET_COLORS } from '../../../utils/constants';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { getThermometerValue } from '../../../utils/temperatureReader';
import ChartMenu from './chartMenu';

interface Props {
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

const renderSymbol = (props: { cx?: number; cy?: number; payload?: { i?: number } }) => {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null) return <g />;
  const i = payload?.i ?? 0;
  const color = PRESET_COLORS[i % PRESET_COLORS.length];
  const s = 5;
  switch (SHAPES[i % SHAPES.length]) {
    case 'square':
      return <rect x={cx - s} y={cy - s} width={2 * s} height={2 * s} fill={color} />;
    case 'triangle':
      return <polygon points={`${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}`} fill={color} />;
    case 'diamond':
      return <polygon points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`} fill={color} />;
    case 'cross':
      return (
        <g stroke={color} strokeWidth={2}>
          <line x1={cx - s} y1={cy} x2={cx + s} y2={cy} />
          <line x1={cx} y1={cy - s} x2={cx} y2={cy + s} />
        </g>
      );
    default:
      return <circle cx={cx} cy={cy} r={s} fill={color} />;
  }
};

const ScatterPlot = ({ thermometersId, type, thermalData }: Props) => {
  const thermometerMap = useCommonStore((state) => state.thermometerMap);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const containerRef = useRef<HTMLDivElement>(null);

  // telelab-style chart display options, controlled from the chart menu.
  const [lineWidth, setLineWidth] = useState(1.5);
  const [errorBars, setErrorBars] = useState(false);
  const [horizontalGrid, setHorizontalGrid] = useState(true);
  const [verticalGrid, setVerticalGrid] = useState(true);

  // Error bar = std dev of each thermometer's temperature across all frames (telelab parity).
  // Keyed on positions/unit (not the per-frame `value`) so playback doesn't trigger a recompute.
  const positionsKey = thermometersId
    .map((id) => {
      const t = thermometerMap.get(id);
      return t ? `${id}:${t.x},${t.y},${t.measuringAreaType},${t.measuringAreaWidth},${t.measuringAreaHeight}` : id;
    })
    .join('|');
  const stdDevById = useMemo(() => {
    const map = new Map<string, number>();
    if (!thermalData) return map;
    thermometersId.forEach((id) => {
      const thermometer = thermometerMap.get(id);
      if (!thermometer) return;
      const temps = thermalData.arrayBuffer.map((buf) =>
        displayTemp(getThermometerValue(buf, thermometer), temperatureUnit),
      );
      map.set(id, stdDev(temps));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermalData, temperatureUnit, positionsKey]);

  const data = thermometersId
    .map((id, i) => {
      const thermometer = thermometerMap.get(id);
      if (!thermometer) return { x: -1, y: 0, i, error: 0 };
      const y = displayTemp(thermometer.value ?? 0, temperatureUnit); // showcase thermometer may lack an initial value
      const error = stdDevById.get(id) ?? 0;
      if (type === 'X') {
        return { x: thermometer.x, y, i, error };
      } else {
        return { x: 1 - thermometer.y, y, i, error };
      }
    })
    .filter((d) => d.x !== -1);

  const unit = temperatureSymbol(temperatureUnit);
  const labelText = type === 'X' ? 'Width' : 'Height';

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
          <YAxis dataKey="y" name="T" type="number" domain={['auto', 'auto']} padding={{ top: 12, bottom: 12 }}>
            <Label value={`T (${unit})`} angle={-90} position={'center'} dx={-5} />
          </YAxis>

          <Tooltip
            formatter={(v: number, name: string, prop) => {
              if (prop.dataKey === 'x') {
                return v.toFixed(3);
              } else {
                return v.toFixed(2) + unit;
              }
            }}
          />

          <Scatter
            isAnimationActive={false}
            data={data}
            line={{ stroke: '#888', strokeWidth: lineWidth }}
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
