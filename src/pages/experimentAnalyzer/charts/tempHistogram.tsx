import { Bar, BarChart, CartesianGrid, Cell, Label, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useMemo, useRef } from 'react';
import useCommonStore, { DEFAULT_HISTOGRAM_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, HistogramChartSettings, LineplotData } from '../../../types';
import { CHART_MARGIN } from '../../../utils/constants';
import { displayTemp, temperatureSymbol } from '../../../utils/helpers';
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

// Bin a decoded frame's Celsius pixels into `bins` equal-width buckets over [minC, maxC). A pixel colder
// or hotter than the fixed clip domain clamps into the edge bin, so every pixel is counted.
const binFrame = (temps: Float32Array, minC: number, widthC: number, bins: number): Int32Array => {
  const counts = new Int32Array(bins);
  for (let i = 0; i < temps.length; i++) {
    let b = Math.floor((temps[i] - minC) / widthC);
    if (b < 0) b = 0;
    else if (b >= bins) b = bins - 1;
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
  const { bins, horizontalGrid, verticalGrid } = useCommonStore(
    (state) => state.experimentMap.get(expId)?.chartSettings?.histogram ?? DEFAULT_HISTOGRAM_CHART_SETTINGS,
  );
  const setHistogram = useCommonStore((state) => state.setHistogramChartSetting);
  const patch = (p: Partial<HistogramChartSettings>) => setHistogram(expId, p);
  const maximizedChart = useCommonStore((state) => state.maximizedChart);
  const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
  const maximized = maximizedChart === ExperimentGraphOption.histogram;
  const containerRef = useRef<HTMLDivElement>(null);

  const unit = temperatureSymbol(temperatureUnit);

  // Fixed temperature domain (Celsius) + fixed Y-max over the sampled frames, so neither axis rescales
  // during playback. Domain endpoints come from each sampled frame's cached min/max (free — the decode
  // already computed them); the Y-max needs one binning pass per sampled frame. Unit-independent (all
  // Celsius), so a °C/°F switch only relabels the axes — no recompute here.
  const clip = useMemo(() => {
    if (!thermalData) return null;
    let minC = Infinity;
    let maxC = -Infinity;
    for (const buf of thermalData.arrayBuffer) {
      try {
        const f = getDecodedFrame(buf);
        if (!f.complete) continue;
        if (f.min < minC) minC = f.min;
        if (f.max > maxC) maxC = f.max;
      } catch {
        // skip an undecodable sampled frame
      }
    }
    if (!Number.isFinite(minC) || maxC <= minC) return null;
    const widthC = (maxC - minC) / bins;
    let yMax = 0;
    for (const buf of thermalData.arrayBuffer) {
      try {
        const f = getDecodedFrame(buf);
        if (!f.complete) continue;
        const counts = binFrame(f.temps, minC, widthC, bins);
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
  }, [thermalData, bins]);

  // The current frame's distribution over the fixed bins (falls back to its own min/max when the clip
  // domain isn't ready — e.g. a recording still fetching the downsample). A truncated frame is skipped so
  // its -273.15 sentinel pixels never pile into bin 0.
  const built = useMemo(() => {
    if (!buffer) return null;
    try {
      const f = getDecodedFrame(buffer);
      if (!f.complete || !Number.isFinite(f.min) || !Number.isFinite(f.max)) return null;
      const minC = clip ? clip.minC : f.min;
      const maxC = clip ? clip.maxC : f.max;
      const widthC = (maxC - minC) / bins || 1e-6; // guard a flat frame (all pixels one temperature)
      const counts = binFrame(f.temps, minC, widthC, bins);
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
  }, [buffer, bins, clip, temperatureUnit]);

  if (!built) {
    return <div className="chart-container chart-loading">loading plot…</div>;
  }

  const { rows, minC, maxC } = built;
  const xTicks = niceTicks(displayTemp(minC, temperatureUnit), displayTemp(maxC, temperatureUnit));
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
            domain={xTicks ? [xTicks[0], xTicks[xTicks.length - 1]] : ['auto', 'auto']}
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
            width={72}
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
