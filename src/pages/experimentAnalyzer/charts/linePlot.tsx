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

    // telelab-style chart display options, controlled from the chart menu.
    const [lineWidth, setLineWidth] = useState(2);
    const [symbolCount, setSymbolCount] = useState(0);
    const [symbolSize, setSymbolSize] = useState(3);
    const [horizontalGrid, setHorizontalGrid] = useState(true);
    const [verticalGrid, setVerticalGrid] = useState(true);

    const init = async () => {
      const data: any = [];
      thermalData.arrayBuffer.forEach((arrayBuffer, index) => {
        const frameData = { time: (index * thermalData.step * thermalData.secondPerFrame).toFixed(1) } as any;
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

    let refX = '0.0';
    if (data) {
      const index = data
        .map((d: any) => d.time)
        .findIndex((t: string) => currFrameIndex * thermalData.secondPerFrame < Number(t));
      if (index !== -1) {
        refX = data[index - 1].time;
      } else {
        refX = data[data.length - 1].time;
      }
    }

    // Show roughly `symbolCount` evenly-spaced symbols along each line (0 = no symbols).
    const dotInterval = symbolCount > 0 && data?.length ? Math.max(1, Math.round(data.length / symbolCount)) : 0;
    const renderDot = (color: string) => (props: any) => {
      const { cx, cy, index } = props;
      if (!dotInterval || index % dotInterval !== 0 || cx == null || cy == null) return <g key={`dot-${index}`} />;
      return <circle key={`dot-${index}`} cx={cx} cy={cy} r={symbolSize} fill={color} />;
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

            <XAxis dataKey="time">
              <Label value={'Time (Second)'} offset={-5} position="bottom" />
            </XAxis>

            <YAxis>
              <Label value={`T (${temperatureSymbol(unit)})`} angle={-90} position={'center'} dx={-5} />
            </YAxis>

            <ReferenceLine x={refX} stroke="orange" strokeWidth={2} />

            <Tooltip
              formatter={(value: number, name) => [`${Number(value).toFixed(2)} ${temperatureSymbol(unit)}`, name]}
              labelFormatter={(label) => `Time: ${label} s`}
            />

            {data &&
              thermometers.map((_value, i) => {
                const color = PRESET_COLORS[i % PRESET_COLORS.length];
                return (
                  <Line
                    key={i}
                    type="monotone"
                    dataKey={`T${i + 1}`}
                    stroke={color}
                    strokeWidth={lineWidth}
                    dot={dotInterval ? renderDot(color) : false}
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
      if (pt.x !== nt.x || pt.y !== nt.y) return false;
    }
    return true;
  },
);

export default Wrapper;
