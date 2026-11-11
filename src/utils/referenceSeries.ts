/**
 * Reference subtraction for the T(t) chart — reading every thermometer against a control.
 *
 * A thermal camera's readings drift together: the sensor warms up, its shutter recalibrates in steps, the
 * room changes. Whatever that adds is (very nearly) the same for every probe in the frame, so the
 * difference between a probe and a control probe placed on an untreated sample is free of it:
 *
 *   measured_i(t) = true_i(t) + drift(t)      →      measured_i(t) − measured_ref(t) = true_i(t) − true_ref(t)
 *
 * That difference is what the chart plots while a reference is chosen (LineChartSettings.referenceId). It
 * is a view of the data, never a rewrite of it: the readings themselves are left as measured, and the
 * CSV keeps them beside the differences. Nothing is assumed about the control's own temperature — which
 * is why the result is a ΔT and not a "corrected" absolute temperature.
 *
 * Pure and unit-agnostic: the values are whatever the rows carry (the chart's are already in the display
 * unit, where a difference of two readings is a correct difference — the °F offset cancels).
 */

type Row = Record<string, unknown>;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// Differences of decimal readings come out with float dust (19.39 − 18.62 = 0.7699999999999996).
const tidy = (v: number) => Number(v.toFixed(6));

/**
 * Rewrite `keys` on every row as that series' difference from `refKey` at the same row. The reference's
 * own series (when listed in `keys`) becomes 0 throughout. A row where the series or the reference has no
 * finite value becomes a gap (null) — never a difference against a missing reading.
 *
 * With `zero`, each series' difference at its first row that has both values is also taken away, so every
 * curve starts at 0: a fixed offset between two probes (an uneven sensor, samples that started at slightly
 * different temperatures) drops out, leaving only what changed since the start.
 *
 * Every other field of a row (its `time`) is carried over untouched. Returns new rows; `rows` is not mutated.
 */
export const relativeToReference = <R extends Row>(rows: R[], keys: string[], refKey: string, zero = false): R[] => {
  const base = new Map<string, number>();
  if (zero) {
    for (const key of keys) {
      for (const row of rows) {
        const v = row[key];
        const r = row[refKey];
        if (finite(v) && finite(r)) {
          base.set(key, v - r);
          break;
        }
      }
    }
  }
  return rows.map((row) => {
    const r = row[refKey];
    const out: Row = { ...row };
    for (const key of keys) {
      const v = row[key];
      out[key] = finite(v) && finite(r) ? tidy(v - r - (base.get(key) ?? 0)) : null;
    }
    return out as R;
  });
};

/** The CSV column a series' difference from the reference is written under ("T2 - T1"). */
export const referenceColumn = (key: string, refKey: string, zero = false) =>
  `${key} - ${refKey}${zero ? ' (zeroed at start)' : ''}`;

/**
 * The rows the chart's CSV holds while a reference is on: the readings as measured (`rawRows`, untouched),
 * then one difference column per other series (`relativeRows`, from relativeToReference over the same
 * rows). The reference has no difference column of its own — it would be a column of zeros.
 */
export const referenceCsvRows = (
  rawRows: Row[],
  relativeRows: Row[],
  keys: string[],
  refKey: string,
  zero = false,
): Row[] =>
  rawRows.map((raw, i) => {
    const out: Row = { ...raw };
    for (const key of keys) {
      if (key === refKey) continue;
      out[referenceColumn(key, refKey, zero)] = relativeRows[i]?.[key] ?? null;
    }
    return out;
  });

/**
 * A temperature difference as text: always signed when it isn't zero ("+0.12", "-0.77"), and never the
 * "-0.00" a tiny negative would round to.
 */
export const formatDelta = (v: number, digits = 2) => {
  const s = v.toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return v > 0 ? `+${s}` : s;
};
