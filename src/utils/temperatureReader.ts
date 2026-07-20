/*
 * @Copyright 2021. Institute for Future Intelligence, Inc.
 */

import { MeasuringAreaType, TemperatureUnit, Thermometer } from '../types';
import { INTSIZE, IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './constants';
import { celsiusToFahrenheit, kelvinToCelsius } from './helpers';
import { getDecodedFrame } from './thermalFrame';

// These readers are thin shells over getDecodedFrame (utils/thermalFrame.ts): the frame is inflated and
// walked ONCE and cached, so reading many probes off one frame — or a probe and the isotherm grid off the
// same frame — costs a single decode. Probe values read the frame's `raw` centi-Kelvin plane, so the
// Celsius output is bit-for-bit identical to the previous per-pixel DataView reads.

const toDisplay = (celsius: number, unit: TemperatureUnit) =>
  Number((unit === TemperatureUnit.fahrenheit ? celsiusToFahrenheit(celsius) : celsius).toFixed(2));

// Point read from a decoded frame's raw plane. Coordinates map through the fixed sensor grid
// (IR_ARRAY_WIDTH/HEIGHT), exactly as the old readers did — regardless of the frame's own resolution. An
// out-of-range index (e.g. x=1 or y=1 landing past the last pixel) reads 0 centi-K → -273.15, matching the
// old slice-past-end sentinel; an in-range index at x=1 still wraps to the next row's first pixel as before.
const rawPointCelsius = (raw: Uint16Array, x: number, y: number) => {
  const idx = Math.floor(y * IR_ARRAY_HEIGHT) * IR_ARRAY_WIDTH + Math.floor(x * IR_ARRAY_WIDTH);
  return kelvinToCelsius((raw[idx] ?? 0) / 100);
};

// Average over a measuring area (rectangle or ellipse centred on x,y), sampled on a 7x7 grid. Samples that
// fall outside the image are skipped; a fully-clipped area returns kelvinToCelsius(0) = -273.15.
const rawAreaAverageCelsius = (
  raw: Uint16Array,
  x: number,
  y: number,
  width: number,
  height: number,
  shape: MeasuringAreaType,
) => {
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
      const idx = Math.floor(py * IR_ARRAY_HEIGHT) * IR_ARRAY_WIDTH + Math.floor(px * IR_ARRAY_WIDTH);
      sum += kelvinToCelsius(raw[idx] / 100);
      count += 1;
    }
  }
  return count ? sum / count : kelvinToCelsius(0);
};

export const getTemperatureAtPosition = (
  arryBuffer: ArrayBufferLike,
  x: number,
  y: number,
  unit: TemperatureUnit = TemperatureUnit.celsius,
) => toDisplay(rawPointCelsius(getDecodedFrame(arryBuffer).raw, x, y), unit);

/** Average temperature over a measuring area (rectangle or ellipse) centred on (x,y). */
export const getAreaAverageTemperature = (
  arryBuffer: ArrayBufferLike,
  x: number,
  y: number,
  width: number,
  height: number,
  shape: MeasuringAreaType,
  unit: TemperatureUnit = TemperatureUnit.celsius,
) => toDisplay(rawAreaAverageCelsius(getDecodedFrame(arryBuffer).raw, x, y, width, height, shape), unit);

/** Read a thermometer's value: a single point, or the average over its measuring area. Celsius. */
export const getThermometerValue = (
  arryBuffer: ArrayBufferLike,
  thermometer: Pick<Thermometer, 'x' | 'y' | 'measuringAreaType' | 'measuringAreaWidth' | 'measuringAreaHeight'>,
) => {
  const { x, y, measuringAreaType, measuringAreaWidth = 0.15, measuringAreaHeight = 0.15 } = thermometer;
  const { raw } = getDecodedFrame(arryBuffer);
  if (measuringAreaType === MeasuringAreaType.Rectangle || measuringAreaType === MeasuringAreaType.Ellipse) {
    return toDisplay(
      rawAreaAverageCelsius(raw, x, y, measuringAreaWidth, measuringAreaHeight, measuringAreaType),
      TemperatureUnit.celsius,
    );
  }
  return toDisplay(rawPointCelsius(raw, x, y), TemperatureUnit.celsius);
};

// Reads consecutive big-endian uint16s (at offset +2 of each 4-byte record) out of an ALREADY-inflated
// buffer. Retained only for the .vir header read in virReader.ts; frame pixels now decode via thermalFrame.
export const readArrayBufferSegment = (arrBuf: ArrayBufferLike, begin: number, length: number) => {
  const intArrView = new DataView(arrBuf.slice(begin * INTSIZE, (begin + length) * INTSIZE));
  const intArr = [];
  for (let i = 0; i < length; i++) {
    try {
      intArr.push(intArrView.getUint16(i * INTSIZE + 2, false));
    } catch (error) {
      // ignore the out of bound errors
    }
  }
  return intArr;
};
