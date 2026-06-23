import { CartesianGrid, Label, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { useRef } from 'react';
import useCommonStore from '../../../stores/common';
import { CHART_MARGIN, PRESET_COLORS } from '../../../utils/constants';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import ChartMenu from './chartMenu';

interface Props {
  type: 'X' | 'Y';
  thermometersId: string[];
}

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

const ScatterPlot = ({ thermometersId, type }: Props) => {
  const thermometerMap = useCommonStore((state) => state.thermometerMap);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const containerRef = useRef<HTMLDivElement>(null);

  const data = thermometersId
    .map((id, i) => {
      const thermometer = thermometerMap.get(id);
      if (!thermometer) return { x: -1, y: 0, i };
      const y = displayTemp(thermometer.value ?? 0, temperatureUnit); // showcase thermometer may lack an initial value
      if (type === 'X') {
        return { x: thermometer.x, y, i };
      } else {
        return { x: 1 - thermometer.y, y, i };
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
        />
      )}
      <ResponsiveContainer width="100%" height={'100%'}>
        <ScatterChart margin={CHART_MARGIN}>
          <CartesianGrid />

          <XAxis dataKey="x" name="X" type="number" domain={[0, 1]} allowDataOverflow={true}>
            <Label value={`${type} (Image ${labelText})`} offset={-5} position="bottom" />
          </XAxis>
          <YAxis dataKey="y" name="T" type="number">
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

          <Scatter isAnimationActive={false} data={data} line={{ stroke: '#888' }} shape={renderSymbol} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ScatterPlot;
