/*
 * @Copyright 2021. Institute for Future Intelligence, Inc.
 */

import Pako from 'pako';
import { MeasuringAreaType, TemperatureUnit, Thermometer } from '../types';
import { INTSIZE, IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import { celsiusToFahrenheit, kelvinToCelsius } from './helpers';

export const getTempFromArrayBuffer = (
  arryBuffer: ArrayBufferLike,
  unit: TemperatureUnit = TemperatureUnit.celsius,
) => {
  const arrBuf = Pako.inflate(arryBuffer);
  return readArrayBufferSegment(arrBuf.buffer, 0, IR_ARRAY_WIDTH * IR_ARRAY_HEIGHT).map((d) => {
    const temp = kelvinToCelsius(d / 100);
    return Number((unit === TemperatureUnit.fahrenheit ? celsiusToFahrenheit(temp) : temp).toFixed(2));
  });
};

export const getTemperatureAtPosition = (
  arryBuffer: ArrayBufferLike,
  x: number,
  y: number,
  unit: TemperatureUnit = TemperatureUnit.celsius,
) => {
  const buffer = Pako.inflate(arryBuffer).buffer;
  const xAbs = Math.floor(x * IR_ARRAY_WIDTH);
  const yAbs = Math.floor(y * IR_ARRAY_HEIGHT);
  const temp = kelvinToCelsius(readArrayBufferPoint(buffer, yAbs * IR_ARRAY_WIDTH + xAbs) / 100);
  return Number((unit === TemperatureUnit.fahrenheit ? celsiusToFahrenheit(temp) : temp).toFixed(2));
};

/** Average temperature over a measuring area (rectangle or ellipse) centred on (x,y). */
export const getAreaAverageTemperature = (
  arryBuffer: ArrayBufferLike,
  x: number,
  y: number,
  width: number,
  height: number,
  shape: MeasuringAreaType,
  unit: TemperatureUnit = TemperatureUnit.celsius,
) => {
  const buffer = Pako.inflate(arryBuffer).buffer;
  const SAMPLES = 7; // grid resolution per axis
  let sum = 0;
  let count = 0;
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const dx = i / (SAMPLES - 1) - 0.5; // -0.5 .. 0.5
      const dy = j / (SAMPLES - 1) - 0.5;
      if (shape === MeasuringAreaType.Ellipse && dx * dx + dy * dy > 0.25) continue; // outside the ellipse
      const px = x + dx * width;
      const py = y + dy * height;
      if (px < 0 || px >= 1 || py < 0 || py >= 1) continue;
      const xAbs = Math.floor(px * IR_ARRAY_WIDTH);
      const yAbs = Math.floor(py * IR_ARRAY_HEIGHT);
      sum += kelvinToCelsius(readArrayBufferPoint(buffer, yAbs * IR_ARRAY_WIDTH + xAbs) / 100);
      count += 1;
    }
  }
  const temp = count ? sum / count : kelvinToCelsius(0);
  return Number((unit === TemperatureUnit.fahrenheit ? celsiusToFahrenheit(temp) : temp).toFixed(2));
};

/** Read a thermometer's value: a single point, or the average over its measuring area. Celsius. */
export const getThermometerValue = (
  arryBuffer: ArrayBufferLike,
  thermometer: Pick<Thermometer, 'x' | 'y' | 'measuringAreaType' | 'measuringAreaWidth' | 'measuringAreaHeight'>,
) => {
  const { x, y, measuringAreaType, measuringAreaWidth = 0.15, measuringAreaHeight = 0.15 } = thermometer;
  if (measuringAreaType === MeasuringAreaType.Rectangle || measuringAreaType === MeasuringAreaType.Ellipse) {
    return getAreaAverageTemperature(arryBuffer, x, y, measuringAreaWidth, measuringAreaHeight, measuringAreaType);
  }
  return getTemperatureAtPosition(arryBuffer, x, y);
};

export const readArrayBufferSegment = (arrBuf: ArrayBufferLike, begin: number, length: number) => {
  let intArrView = new DataView(arrBuf.slice(begin * INTSIZE, (begin + length) * INTSIZE));
  let intArr = [];
  for (let i = 0; i < length; i++) {
    try {
      intArr.push(intArrView.getUint16(i * INTSIZE + 2, false));
    } catch (error) {
      // ignore the out of bound errors
    }
  }
  return intArr;
};

export const readArrayBufferPoint = (arrBuf: ArrayBufferLike, begin: number) => {
  let intArrView = new DataView(arrBuf.slice(begin * INTSIZE, (begin + 1) * INTSIZE));
  try {
    return intArrView.getUint16(2, false);
  } catch (error) {
    // ignore the out of bound errors
    return 0;
  }
};
