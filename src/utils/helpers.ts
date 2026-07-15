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

/**
 * The route that an experiment's author credit links to, or undefined when it isn't linkable.
 * Real owners (a mongoId) go to their public profile; seeded showcases (ownerId 'system', no
 * usersPublic doc) go to their by-author gallery keyed on the author string; anything without an
 * owner, or a system showcase missing its author, isn't a link.
 */
export const authorProfilePath = (ownerId?: string, author?: string): string | undefined => {
  if (!ownerId) return undefined;
  if (ownerId !== 'system') return `/users/${ownerId}`;
  return author ? `/showcase/authors/${encodeURIComponent(author)}` : undefined;
};

/** Seconds → m:ss (e.g. 75 → "1:15"); rounds away the sensor's fractional seconds. */
export const formatDuration = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
