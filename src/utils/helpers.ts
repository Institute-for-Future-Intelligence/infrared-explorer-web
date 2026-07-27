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

/** Inverse of displayTemp: a value the user typed/read in the display unit back to Celsius for storage. */
export const fromDisplayTemp = (value: number, unit: TemperatureUnit) =>
  unit === TemperatureUnit.fahrenheit ? fahrenheitToCelsius(value) : value;

/**
 * Convert a Celsius temperature DIFFERENCE (ΔT) to the display unit. A difference scales by 9/5 but takes
 * NO +32 zero offset (that would be right for an absolute reading, wrong for a delta) — so a 5 °C rise
 * reads as 9 °F, not 41 °F.
 */
export const displayTempDelta = (deltaCelsius: number, unit: TemperatureUnit) =>
  unit === TemperatureUnit.fahrenheit ? (deltaCelsius * 9) / 5 : deltaCelsius;

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

/**
 * Nice round gridlines plus an axis domain that hugs the true [min, max] of the data, so the
 * lines fill the plot instead of floating below a near-empty top band. Snapping the domain out
 * to the round tick span (the old [first, last]) leaves close to a full step of empty space
 * whenever the data only just crosses a tick boundary — e.g. a 22.05 °C peak forces a 23 °C top
 * tick and blanks the whole 22→23 band. Here the domain is the data range itself, and any tick
 * that falls outside it is dropped so no label floats past the plot edge.
 *
 * Falls back to the round tick span when hugging would collapse the axis (flat data) or leave
 * fewer than two gridlines (a very narrow range sitting inside one tick step), so the axis never
 * degenerates or shows a lone gridline. Returns undefined for non-finite input.
 */
export const niceTemperatureAxis = (
  min: number,
  max: number,
  count = 5,
): { ticks: number[]; domain: [number, number] } | undefined => {
  const ticks = niceTemperatureTicks(min, max, count);
  if (!ticks) return undefined;
  const span = ticks[ticks.length - 1] - ticks[0];
  const eps = (span || 1) * 1e-6; // tolerate float dust so a tick landing exactly on min/max is kept
  const inRange = ticks.filter((t) => t >= min - eps && t <= max + eps);
  if (max > min && inRange.length >= 2) {
    return { ticks: inRange, domain: [min, max] };
  }
  return { ticks, domain: [ticks[0], ticks[ticks.length - 1]] };
};
