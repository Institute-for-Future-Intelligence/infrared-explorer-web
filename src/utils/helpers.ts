import { TemperatureUnit } from '../types';

export const kelvinToCelsius = (temp: number) => {
  return temp - 273.15;
};

export const fahrenheitToCelsius = (temp: number) => {
  return ((temp - 32) * 5) / 9;
};

export const celsiusToFahrenheit = (temp: number) => {
  return temp * (9 / 5) + 32;
};

/** Convert a raw Celsius reading to the requested display unit. */
export const displayTemp = (celsius: number, unit: TemperatureUnit) =>
  unit === TemperatureUnit.fahrenheit ? celsiusToFahrenheit(celsius) : celsius;

export const temperatureSymbol = (unit: TemperatureUnit) => (unit === TemperatureUnit.fahrenheit ? '°F' : '°C');
