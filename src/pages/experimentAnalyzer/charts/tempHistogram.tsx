import { Bar, BarChart, CartesianGrid, Cell, Label, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useMemo, useRef } from 'react';
import useCommonStore, { DEFAULT_HISTOGRAM_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, HistogramChartSettings, LineplotData } from '../../../types';
import { CHART_MARGIN, Y_AXIS_WIDTH } from '../../../utils/constants';
import { displayTemp, fromDisplayTemp, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { temp01ToCss } from '../../../utils/colormap';
import ChartMenu from './chartMenu';
import { renderYAxisTitle } from './chartLabels';

interface Props {
  expId: string;
  // The displayed frame's decoded-thermal buffer (the players pass the current frame; undefined until it
  // lands for a recording). The distribution is re-binned from this each render, so the bars animate.
  buffer: ArrayBuffer | undefined;
  // The ≤25-frame downsample (same set T(t) uses). When present, both axes are fixed to the clip's range
  // so they don't rescale frame-to-frame; absent → the current frame's own range.
  thermalData: LineplotData | null;
}

/** Nice 1/2/5×10ⁿ tick values for an axis (shared shape with the scatter / profile plots). */
const niceTicks = (min: number, max: number, count = 5): number[] | undefined => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  const rawStep = (max - min || 1) / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = Math.max(0.1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const start = Math.floor(min / step) * step;
  let end = Math.ceil(max / step) * step;
  if (end <= start) end = start + step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
};

// Bin a decoded frame's Celsius pixels into `bins` equal-width buckets over [minC, maxC). With `clamp`, a
// pixel colder or hotter than the domain lands in the edge bin, so every pixel is counted (AUTO range — the
// domain is the clip's own extent, so only an unsampled frame's outliers spill). Without it (a user-set
// range) out-of-range pixels are left out, so they don't pile up as a fake spike at the edge.
const binFrame = (temps: Float32Array, minC: number, widthC: number, bins: number, clamp = true): Int32Array => {
  const counts = new Int32Array(bins);
  for (let i = 0; i < temps.length; i++) {
    let b = Math.floor((temps[i] - minC) / widthC);
    if (b < 0) {
      if (!clamp) continue;
      b = 0;
    } else if (b >= bins) {
      if (!clamp && temps[i] > minC + widthC * bins) continue;
      b = bins - 1;
    }
    counts[b]++;
  }
  return counts;
};

interface HistRow {
  tC: number; // bin-centre temperature in Celsius (binning is unit-independent)
  t: number; // bin-centre temperature in the display unit (axis / tooltip)
  pct: number; // share of the frame's pixels in this bin (%)
  count: number; // pixel count in this bin
  ct: number; // normalised palette position 0(cold)→1(hot) for the bar colour
}

const HistTooltip = ({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: { payload: HistRow }[];
  unit: string;
}) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #ccc',
        padding: '8px 10px',
        whiteSpace: 'nowrap',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{`${p.t.toFixed(1)} ${unit}`}</div>
      <div>{`${p.pct.toFixed(1)}% of pixels`}</div>
      <div>{`${p.count.toLocaleString()} px`}</div>
    </div>
  );
};

/**
 * N(T): the current frame's temperature distribution — every pixel of the 120×160 grid binned into equal-
 * width temperature buckets, drawn as a histogram (bar height = share of pixels, bar colour = its bin's
 * temperature on the blue→red ramp). Live-coupled to the player: the buffer prop swaps each frame so the
 * distribution animates during playback. The temperature axis and the Y (%) axis are fixed over the ≤25-
 * frame downsample so the shape moves within a stable frame instead of the axes rescaling every tick.
 * Bin count / grid from the shared ChartMenu; CSV / PNG export via the same menu.
 */
const TempHistogram = ({ expId, buffer, thermalData }: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const {
    bins,
    horizontalGrid,
    verticalGrid,
    tMin = null,
    tMax = null,
  } = useCommonStore(
    (state) => state.experimentMap.get(expId)?.chartSettings?.histogram ?? DEFAULT_HISTOGRAM_CHART_SETTINGS,
  );
  const setHistogram = useCommonStore((state) => state.setHistogramChartSetting);
  const patch = (p: Partial<HistogramChartSettings>) => setHistogram(expId, p);
  const maximizedChart = useCommonStore((state) => state.maximizedChart);
  const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
  const maximized = maximizedChart === ExperimentGraphOption.histogram;
  const containerRef = useRef<HTMLDivElement>(null);

  const unit = temperatureSymbol(temperatureUnit);

  // AUTO temperature domain (Celsius), fixed over the sampled frames so it doesn't rescale during playback.
  // It spans the 0.1th–99.9th percentile of all sampled pixels, not the raw min/max: a handful of hot/cold
  // outlier pixels in one frame would otherwise stretch the axis and squash the real distribution into a
  // corner. The trimmed tails (≤0.2% of pixels) clamp into the edge bins, so every pixel is still counted.
  // Percentiles come off a fine 2000-bucket pre-histogram between the raw extremes (no sort). Unit-
  // independent (all Celsius), so a °C/°F switch only relabels the axes — no recompute here.
  const autoRange = useMemo(() => {
    if (!thermalData) return null;
    const frames: Float32Array[] = [];
    let minC = Infinity;
    let maxC = -Infinity;
    for (const buf of thermalData.arrayBuffer) {
      try {
        const f = getDecodedFrame(buf);
        if (!f.complete) continue;
        frames.push(f.temps);
        if (f.min < minC) minC = f.min;
        if (f.max > maxC) maxC = f.max;
      } catch {
        // skip an undecodable sampled frame
      }
    }
    if (!Number.isFinite(minC) || maxC <= minC) return null;
    const FINE = 2000;
    const fineW = (maxC - minC) / FINE;
    const fine = new Float64Array(FINE);
    let total = 0;
    for (const temps of frames) {
      const c = binFrame(temps, minC, fineW, FINE);
      for (let i = 0; i < FINE; i++) fine[i] += c[i];
      total += temps.length;
    }
    const cut = total * 0.001;
    let lo = 0;
    for (let acc = 0; lo < FINE - 1 && acc + fine[lo] <= cut; lo++) acc += fine[lo];
    let hi = FINE - 1;
    for (let acc = 0; hi > lo && acc + fine[hi] <= cut; hi--) acc += fine[hi];
    return { minC: minC + lo * fineW, maxC: minC + (hi + 1) * fineW };
  }, [thermalData]);

  // A user-set end overrides that end of the AUTO range (either end may be set alone).
  const custom = tMin !== null || tMax !== null;

  // The Y-max over the sampled frames, binned over the effective range.
  const clip = useMemo(() => {
    if (!thermalData || !autoRange) return null;
    const minC = tMin ?? autoRange.minC;
    const maxC = tMax ?? autoRange.maxC;
    if (maxC <= minC) return null;
    const widthC = (maxC - minC) / bins;
    let yMax = 0;
    for (const buf of thermalData.arrayBuffer) {
      try {
        const f = getDecodedFrame(buf);
        if (!f.complete) continue;
        const counts = binFrame(f.temps, minC, widthC, bins, !custom);
        const total = f.temps.length;
        for (let i = 0; i < counts.length; i++) {
          const pct = (counts[i] / total) * 100;
          if (pct > yMax) yMax = pct;
        }
      } catch {
        // skip an undecodable sampled frame
      }
    }
    return { minC, maxC, yMax };
  }, [thermalData, autoRange, bins, tMin, tMax, custom]);

  // The current frame's distribution over the fixed bins (falls back to its own min/max when the clip
  // domain isn't ready — e.g. a recording still fetching the downsample). A truncated frame is skipped so
  // its -273.15 sentinel pixels never pile into bin 0.
  const built = useMemo(() => {
    if (!buffer) return null;
    try {
      const f = getDecodedFrame(buffer);
      if (!f.complete || !Number.isFinite(f.min) || !Number.isFinite(f.max)) return null;
      const minC = clip ? clip.minC : (tMin ?? f.min);
      const maxC = clip ? clip.maxC : (tMax ?? f.max);
      if (maxC < minC) return null;
      const widthC = (maxC - minC) / bins || 1e-6; // guard a flat frame (all pixels one temperature)
      const counts = binFrame(f.temps, minC, widthC, bins, !custom);
      const total = f.temps.length;
      const rows: HistRow[] = Array.from(counts, (c, i) => {
        const tC = minC + (i + 0.5) * widthC;
        return {
          tC,
          t: displayTemp(tC, temperatureUnit),
          pct: (c / total) * 100,
          count: c,
          ct: (i + 0.5) / bins,
        };
      });
      return { rows, minC, maxC };
    } catch (e) {
      console.error('failed to build temperature histogram', e);
      return null;
    }
  }, [buffer, bins, clip, tMin, tMax, custom, temperatureUnit]);

  if (!built) {
    return <div className="chart-container chart-loading">loading plot…</div>;
  }

  const { rows, minC, maxC } = built;
  const xLo = displayTemp(minC, temperatureUnit);
  const xHi = displayTemp(maxC, temperatureUnit);
  // The axis spans exactly the binned range (AUTO or user-set), so the bars fill the plot edge to edge —
  // no widening out to round tick values — with only the nice ticks that fall inside it.
  const xTicks = niceTicks(xLo, xHi, 8)?.filter((v) => v >= xLo - 1e-6 && v <= xHi + 1e-6);
  const xDomain: [number, number] = [xLo, xHi];
  // What AUTO resolves to (placeholder in the menu's range boxes): the clip's extent, else this frame's.
  const autoLo = autoRange ? autoRange.minC : minC;
  const autoHi = autoRange ? autoRange.maxC : maxC;
  const maxPct = clip ? clip.yMax : Math.max(...rows.map((r) => r.pct));
  const yTicks = niceTicks(0, maxPct);

  const exportCSV = () =>
    downloadCSV(
      timestampedName('temperature-histogram', 'csv'),
      rows.map((r) => ({ [`T (${unit})`]: r.t, pixels: r.count, percent: Number(r.pct.toFixed(3)) })),
    );

  return (
    <div className="chart-container" style={{ position: 'relative' }} ref={containerRef}>
      <ChartMenu
        onSavePNG={() =>
          containerRef.current && exportElementToPNG(containerRef.current, timestampedName('histogram', 'png'))
        }
        onExportCSV={exportCSV}
        maximized={maximized}
        onToggleMaximize={() => setMaximizedChart(maximized ? null : ExperimentGraphOption.histogram)}
        controls={{
          bins,
          binsMin: 10,
          binsMax: 100,
          onBins: (v: number) => patch({ bins: v }),
          range: {
            min: tMin === null ? null : Number(displayTemp(tMin, temperatureUnit).toFixed(1)),
            max: tMax === null ? null : Number(displayTemp(tMax, temperatureUnit).toFixed(1)),
            auto: [displayTemp(autoLo, temperatureUnit), displayTemp(autoHi, temperatureUnit)],
            unit,
          },
          onRange: (lo: number | null, hi: number | null) =>
            patch({
              tMin: lo === null ? null : fromDisplayTemp(lo, temperatureUnit),
              tMax: hi === null ? null : fromDisplayTemp(hi, temperatureUnit),
            }),
          horizontalGrid,
          onHorizontalGrid: (v: boolean) => patch({ horizontalGrid: v }),
          verticalGrid,
          onVerticalGrid: (v: boolean) => patch({ verticalGrid: v }),
        }}
      />
      <ResponsiveContainer width="100%" height={'100%'}>
        <BarChart data={rows} margin={CHART_MARGIN} barCategoryGap={0} barGap={0}>
          <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />
          <XAxis
            dataKey="t"
            type="number"
            domain={xDomain}
            ticks={xTicks}
            allowDataOverflow
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label value={`T (${unit})`} offset={-5} position="bottom" />
          </XAxis>
          <YAxis
            type="number"
            domain={yTicks ? [0, yTicks[yTicks.length - 1]] : [0, 'auto']}
            ticks={yTicks}
            width={Y_AXIS_WIDTH}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          >
            <Label content={renderYAxisTitle('Pixels (%)')} />
          </YAxis>
          <Tooltip content={<HistTooltip unit={unit} />} cursor={{ fill: 'rgba(0,0,0,0.06)' }} />
          <Bar dataKey="pct" isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.tC} fill={temp01ToCss(r.ct)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TempHistogram;
