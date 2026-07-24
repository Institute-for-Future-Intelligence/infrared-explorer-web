import { CartesianGrid, Label, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useMemo, useRef } from 'react';
import useCommonStore, { DEFAULT_PROFILE_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, LineplotData, ProfileChartSettings, ProfileLine } from '../../../types';
import { CHART_MARGIN } from '../../../utils/constants';
import { displayTemp, niceTemperatureTicks, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { sampleLineProfile, profileColor } from '../../../utils/lineProfile';
import ChartMenu from './chartMenu';
import { renderYAxisTitle } from './chartLabels';

// Every transect is sampled at this many evenly-spaced positions so all series share one X-row set
// (position 0→1), regardless of each line's on-image length.
const SAMPLES = 120;

interface Props {
  expId: string;
  // The displayed frame's decoded-thermal buffer (the players pass the current frame; undefined until it
  // lands for a recording). The profiles are resampled from this each render, so the curves track playback.
  buffer: ArrayBuffer | undefined;
  // The ≤25-frame downsample (same set the T(t) plot uses). When present, the temperature axis is fixed to
  // the profiles' whole-clip range so it doesn't rescale frame-to-frame; absent → the current frame's range.
  thermalData: LineplotData | null;
}

const seriesKey = (line: ProfileLine) => `t_${line.id}`;

// Sample every line at the shared SAMPLES positions and zip into rows { pos, t_<id>: temp, ... }.
const buildRows = (
  buffer: ArrayBuffer,
  lines: ProfileLine[],
  unit: Parameters<typeof displayTemp>[1],
): Record<string, number>[] => {
  const frame = getDecodedFrame(buffer);
  const perLine = lines.map((line) =>
    sampleLineProfile(frame.temps, frame.width, frame.height, line, SAMPLES).map((s) => displayTemp(s.tempC, unit)),
  );
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const row: Record<string, number> = { pos: i / (SAMPLES - 1) };
    lines.forEach((line, j) => {
      row[seriesKey(line)] = perLine[j][i];
    });
    rows.push(row);
  }
  return rows;
};

const ProfileTooltip = ({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: number;
  unit: string;
}) => {
  if (!active || !payload?.length) return null;
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
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{`Position: ${(label ?? 0).toFixed(3)}`}</div>
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }}>{`${p.name}: ${p.value?.toFixed(2)}${unit}`}</div>
      ))}
    </div>
  );
};

/**
 * T(l): temperature sampled along each user-drawn transect (see ProfileLineOverlay) for the current frame —
 * one coloured series per line, X = position 0(A)→1(B), Y = temperature. Live-coupled to the player: the
 * buffer prop swaps each frame so the curves animate during playback. Add/delete lines from the manager row
 * above the charts (ProfileLineManager). CSV / PNG export via the shared ChartMenu.
 */
const ProfilePlot = ({ expId, buffer, thermalData }: Props) => {
  const temperatureUnit = useCommonStore((state) => state.temperatureUnit);
  const lines = useCommonStore((state) => state.experimentMap.get(expId)?.profileLines) ?? [];
  const { lineWidth, horizontalGrid, verticalGrid } = useCommonStore(
    (state) => state.experimentMap.get(expId)?.chartSettings?.profile ?? DEFAULT_PROFILE_CHART_SETTINGS,
  );
  const setProfile = useCommonStore((state) => state.setProfileChartSetting);
  const patch = (p: Partial<ProfileChartSettings>) => setProfile(expId, p);
  const maximizedChart = useCommonStore((state) => state.maximizedChart);
  const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
  const maximized = maximizedChart === ExperimentGraphOption.lineProfile;
  const containerRef = useRef<HTMLDivElement>(null);

  const unit = temperatureSymbol(temperatureUnit);
  // Keyed on geometry + id + order so the memos recompute on a drag / add / delete but not on playback alone.
  const linesKey = lines.map((l) => `${l.id}:${l.x1},${l.y1},${l.x2},${l.y2}`).join('|');
  // Series label: the user-given name, else the positional default "L1", "L2", … (matches the overlay).
  const nameFor = (line: ProfileLine) => line.name?.trim() || `L${lines.indexOf(line) + 1}`;

  // Current-frame curves (one row set, one column per line).
  const data = useMemo(() => {
    if (!buffer || lines.length === 0) return [];
    try {
      return buildRows(buffer, lines, temperatureUnit);
    } catch (e) {
      console.error('failed to sample line profiles', e);
      return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, temperatureUnit, linesKey]);

  // Fixed temperature range over the sampled frames so the axis doesn't jump during playback (falls back to
  // the current frame when the downsample isn't available, e.g. before a recording's plot data has loaded).
  const clipRange = useMemo(() => {
    if (!thermalData || lines.length === 0) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const buf of thermalData.arrayBuffer) {
      try {
        const frame = getDecodedFrame(buf);
        for (const line of lines) {
          for (const s of sampleLineProfile(frame.temps, frame.width, frame.height, line, SAMPLES)) {
            const t = displayTemp(s.tempC, temperatureUnit);
            if (t < min) min = t;
            if (t > max) max = t;
          }
        }
      } catch {
        // skip an undecodable sampled frame
      }
    }
    return Number.isFinite(min) ? ([min, max] as [number, number]) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thermalData, temperatureUnit, linesKey]);

  if (lines.length === 0) {
    return <div className="chart-container chart-hint">Add a line from the toolbar to plot temperature along it.</div>;
  }
  // Lines exist but the current frame's thermal data hasn't landed yet (recording still fetching the .dat).
  if (data.length === 0) {
    return <div className="chart-container chart-loading">loading plot…</div>;
  }

  // Y range from the current frame's data when the fixed clip range isn't ready.
  const frameValues = data.flatMap((r) => lines.map((l) => r[seriesKey(l)]).filter((v) => Number.isFinite(v)));
  const [yMin, yMax] = clipRange ?? [Math.min(...frameValues), Math.max(...frameValues)];
  const yTicks = niceTemperatureTicks(yMin, yMax);

  const exportCSV = () =>
    downloadCSV(
      timestampedName('temperature-line', 'csv'),
      data.map((r) => {
        const row: Record<string, number> = { position: r.pos };
        lines.forEach((line) => {
          row[`${nameFor(line)} (${unit})`] = r[seriesKey(line)];
        });
        return row;
      }),
    );

  return (
    <div className="chart-container" style={{ position: 'relative' }} ref={containerRef}>
      {data.length > 0 && (
        <ChartMenu
          onSavePNG={() =>
            containerRef.current && exportElementToPNG(containerRef.current, timestampedName('lineprofile', 'png'))
          }
          onExportCSV={exportCSV}
          maximized={maximized}
          onToggleMaximize={() => setMaximizedChart(maximized ? null : ExperimentGraphOption.lineProfile)}
          controls={{
            lineWidth,
            onLineWidth: (v: number) => patch({ lineWidth: v }),
            horizontalGrid,
            onHorizontalGrid: (v: boolean) => patch({ horizontalGrid: v }),
            verticalGrid,
            onVerticalGrid: (v: boolean) => patch({ verticalGrid: v }),
          }}
        />
      )}
      <ResponsiveContainer width="100%" height={'100%'}>
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />
          <XAxis
            dataKey="pos"
            type="number"
            domain={[0, 1]}
            allowDataOverflow
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label value="Position along line (A→B)" offset={-5} position="bottom" />
          </XAxis>
          <YAxis
            type="number"
            domain={yTicks ? [yTicks[0], yTicks[yTicks.length - 1]] : ['auto', 'auto']}
            ticks={yTicks}
            width={72}
            padding={{ top: 12, bottom: 12 }}
            tickFormatter={(v: number) => v.toFixed(1)}
          >
            <Label content={renderYAxisTitle(`T (${unit})`)} />
          </YAxis>
          <Tooltip content={<ProfileTooltip unit={unit} />} />
          {lines.length > 1 && <Legend verticalAlign="top" height={24} />}
          {lines.map((line, i) => (
            <Line
              key={line.id}
              type="monotone"
              dataKey={seriesKey(line)}
              name={nameFor(line)}
              stroke={profileColor(i)}
              strokeWidth={lineWidth}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default ProfilePlot;
