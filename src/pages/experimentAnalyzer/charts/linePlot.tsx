import {
  CartesianGrid,
  Label,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CHART_MARGIN, PRESET_COLORS } from '../../../utils/constants';
import useCommonStore from '../../../stores/common';
import { LineplotData, TemperatureUnit, Thermometer } from '../../../types';
import React, { useEffect, useRef, useState } from 'react';
import { getThermometerValue } from '../../../utils/temperatureReader';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import ChartMenu from './chartMenu';
import { renderYAxisTitle } from './chartLabels';

interface WrapperProps {
  thermometersId: string[];
  thermalData: LineplotData;
  currFrameIndex: number;
  updateFrame: (index: number) => void;
}

interface Props {
  thermometers: Thermometer[];
  thermalData: LineplotData;
  currFrameIndex: number;
  updateFrame: (index: number) => void;
  unit: TemperatureUnit;
}

const Wrapper = ({ thermometersId, thermalData, currFrameIndex, updateFrame }: WrapperProps) => {
  const thermometerMap = useCommonStore((state) => state.thermometerMap);
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const thermometers = thermometersId.map((id) => thermometerMap.get(id)).filter((v) => v !== undefined);
  return (
    <LinePlot
      thermometers={thermometers}
      thermalData={thermalData}
      currFrameIndex={currFrameIndex}
      updateFrame={updateFrame}
      unit={temperatureUnit}
    />
  );
};

const LinePlot = React.memo(
  ({ thermometers, thermalData, currFrameIndex, updateFrame, unit }: Props) => {
    const [data, setData] = useState<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    // When a thermometer is hovered in the image, dim every other line so its series stands out.
    const hoveredId = useCommonStore((state) => state.hoveredThermometerId);

    // telelab-style chart display options, controlled from the chart menu. Held in the store (not local
    // state) so they survive the workspace unmounting the chart on a mode switch. Setters patch the slice.
    const { lineWidth, symbolCount, symbolSize, horizontalGrid, verticalGrid } = useCommonStore(
      (state) => state.lineChartSettings,
    );
    const patch = useCommonStore((state) => state.setLineChartSettings);
    const setLineWidth = (v: number) => patch({ lineWidth: v });
    const setSymbolCount = (v: number) => patch({ symbolCount: v });
    const setSymbolSize = (v: number) => patch({ symbolSize: v });
    const setHorizontalGrid = (v: boolean) => patch({ horizontalGrid: v });
    const setVerticalGrid = (v: boolean) => patch({ verticalGrid: v });

    const init = async () => {
      const data: any = [];
      thermalData.arrayBuffer.forEach((arrayBuffer, index) => {
        const frameData = { time: Number((index * thermalData.step * thermalData.secondPerFrame).toFixed(1)) } as any;
        thermometers.forEach((thermometer, index) => {
          frameData[`T${index + 1}`] = displayTemp(getThermometerValue(arrayBuffer, thermometer), unit);
        });
        data.push(frameData);
      });
      setData(data);
    };

    useEffect(() => {
      init();
    }, [thermometers, thermalData, unit]);

    let refX = 0;
    if (data) {
      const index = data
        .map((d: any) => d.time)
        .findIndex((t: number) => currFrameIndex * thermalData.secondPerFrame < t);
      if (index !== -1) {
        refX = data[index - 1].time;
      } else {
        refX = data[data.length - 1].time;
      }
    }

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
          >
            <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />

            <XAxis dataKey="time" type="number" domain={[0, maxTime]} ticks={xTicks} allowDecimals={false}>
              <Label value={'Time (Second)'} offset={-5} position="bottom" />
            </XAxis>

            {/* width matches the scatter plots so all three charts' plot areas line up */}
            <YAxis type="number" domain={['dataMin - 5', 'auto']} width={72}>
              <Label content={renderYAxisTitle(`T (${temperatureSymbol(unit)})`)} />
            </YAxis>

            <ReferenceLine x={refX} stroke="orange" strokeWidth={2} />

            <Tooltip
              formatter={(value: number, name) => [`${Number(value).toFixed(2)} ${temperatureSymbol(unit)}`, name]}
              labelFormatter={(label) => `Time: ${label} s`}
            />

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
