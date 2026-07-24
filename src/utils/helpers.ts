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

/**
 * Round, evenly-spaced tick values that hug [min, max] so the temperature axis fills the plot
 * instead of floating in a fixed range. Used by every T-vs-something chart (T(t), T(x), T(y), T(l))
 * to derive both the tick labels and the axis domain ([first, last]) from the data itself.
 * Returns undefined for non-finite input; guarantees a non-degenerate range when all readings match.
 */
export const niceTemperatureTicks = (min: number, max: number, count = 5): number[] | undefined => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  const rawStep = (max - min || 1) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = Math.max(0.1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const start = Math.floor(min / step) * step;
  let end = Math.ceil(max / step) * step;
  if (end <= start) end = start + step; // guarantee a non-degenerate range (e.g. all readings equal)
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
};
