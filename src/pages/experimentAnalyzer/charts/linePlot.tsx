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
import React, { useEffect, useState } from 'react';
import { getTemperatureAtPosition } from '../../../utils/temperatureReader';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';

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

    const init = async () => {
      const data: any = [];
      thermalData.arrayBuffer.forEach((arrayBuffer, index) => {
        const frameData = { time: (index * thermalData.step * thermalData.secondPerFrame).toFixed(1) } as any;
        thermometers.forEach((thermometer, index) => {
          frameData[`T${index}`] = displayTemp(
            getTemperatureAtPosition(arrayBuffer, thermometer.x, thermometer.y),
            unit,
          );
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

    return (
      <div className="chart-container">
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
            <CartesianGrid />

            <XAxis dataKey="time">
              <Label value={'Time (Second)'} offset={-5} position="bottom" />
            </XAxis>

            <YAxis>
              <Label value={`T (${temperatureSymbol(unit)})`} angle={-90} position={'center'} dx={-5} />
            </YAxis>

            <ReferenceLine x={refX} stroke="orange" strokeWidth={2} />

            <Tooltip />

            {data &&
              thermometers.map((value, i) => {
                return (
                  <Line key={i} type="monotone" dataKey={`T${i}`} stroke={PRESET_COLORS[i]} isAnimationActive={false} />
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
