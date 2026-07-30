import {
  CartesianGrid,
  Label,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useEffect, useMemo, useRef } from 'react';
import { InputNumber } from 'antd';
import useCommonStore, { DEFAULT_PROFILE_CHART_SETTINGS } from '../../../stores/common';
import { ExperimentGraphOption, LineplotData, ProfileChartSettings, ProfileLine } from '../../../types';
import { CHART_MARGIN, Y_AXIS_WIDTH } from '../../../utils/constants';
import { displayTemp, niceTemperatureAxis, temperatureSymbol } from '../../../utils/helpers';
import { downloadCSV, exportElementToPNG, timestampedName } from '../../../utils/exporters';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { sampleLineProfile, profileColor, linearFit, linePixelLength, LinearFit } from '../../../utils/lineProfile';
import ChartMenu from './chartMenu';
import { renderYAxisTitle, yTickFormatter } from './chartLabels';

// Minimum selected span (in position units, 0→1) for the gradient tool to fit — a shorter drag reads as a
// click and clears the current selection instead.
const MIN_GRADIENT_SPAN = 0.02;

// Adaptive slope formatting. Large values read best as fixed decimals; small ones (a typical °/px slope
// can be ~0.002) need significant figures instead, so two nearby slopes don't both collapse to "0.002".
const fmtSlope = (v: number): string => {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return Number(v.toPrecision(3)).toString(); // 3 sig figs → 0.00184 vs 0.00211, not both "0.002"
};

// Signed temperature change across the selection (ΔT), e.g. "+0.13" / "-1.4". Always meaningful without
// any length calibration, and with better dynamic range than a tiny °/px slope.
const fmtDelta = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 2 : 1)}`;

// A calibrated real length only counts when it's a positive finite number (a Firestore-read null, an
// undefined, or a stray 0/negative all mean "uncalibrated" → fall back to °/pixel).
const calibratedCm = (line: ProfileLine): number | null =>
  typeof line.lengthCm === 'number' && line.lengthCm > 0 ? line.lengthCm : null;

// Clamp a recharts activeLabel (the X value under the cursor) into the [0,1] position axis, or null when
// it isn't a finite number (pointer off the plot area).
const clampPos = (raw: unknown): number | null => {
  const p = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
};

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
  // When a transect is hovered in the image, emphasize its series and dim the rest (like the T(t) chart).
  const hoveredLineId = useCommonStore((state) => state.hoveredProfileLineId);
  const { lineWidth, horizontalGrid, verticalGrid } = useCommonStore(
    (state) => state.experimentMap.get(expId)?.chartSettings?.profile ?? DEFAULT_PROFILE_CHART_SETTINGS,
  );
  const setHoveredProfilePos = useCommonStore((state) => state.setHoveredProfilePos);
  // Drop the probe marker if this chart unmounts (e.g. a tab switch) while the pointer is still over it,
  // so it doesn't linger on the image.
  useEffect(() => () => setHoveredProfilePos(null), [setHoveredProfilePos]);
  const setProfile = useCommonStore((state) => state.setProfileChartSetting);
  const patch = (p: Partial<ProfileChartSettings>) => setProfile(expId, p);
  const maximizedChart = useCommonStore((state) => state.maximizedChart);
  const setMaximizedChart = useCommonStore((state) => state.setMaximizedChart);
  const maximized = maximizedChart === ExperimentGraphOption.lineProfile;
  const containerRef = useRef<HTMLDivElement>(null);

  // Gradient tool (dT/dx): drag-select a position interval and fit a slope per transect. Mode + selection
  // are transient store state (survive a maximize, cleared on leave); the calibrated length lives on the line.
  const gradientMode = useCommonStore((state) => state.profileGradientMode);
  const setGradientMode = useCommonStore((state) => state.setProfileGradientMode);
  const gradientRange = useCommonStore((state) => state.profileGradientRange);
  const setGradientRange = useCommonStore((state) => state.setProfileGradientRange);
  const updateProfileLine = useCommonStore((state) => state.updateProfileLine);
  // Position where the current drag-select started (null when not dragging); a ref so a drag doesn't re-render.
  const dragStartRef = useRef<number | null>(null);

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

  // Frame pixel dimensions (LRU-cached decode, shared with buildRows) — the °/pixel denominator for an
  // uncalibrated gradient. null before the current frame's thermal data lands.
  const frameDims = useMemo(() => {
    if (!buffer) return null;
    try {
      const f = getDecodedFrame(buffer);
      return { width: f.width, height: f.height };
    } catch {
      return null;
    }
  }, [buffer]);

  // Per-line least-squares fit over the selected interval (the gradient tool). Recomputed on the current
  // frame's `data`, so scrubbing playback updates each slope live. `slope` is d(temp)/d(position 0→1); the
  // °/cm or °/px conversion happens at render from each line's calibrated length. null when nothing selected.
  const fits = useMemo(() => {
    if (!gradientRange || data.length === 0 || lines.length === 0) return null;
    const lo = Math.min(gradientRange[0], gradientRange[1]);
    const hi = Math.max(gradientRange[0], gradientRange[1]);
    const inRange = data.filter((r) => r.pos >= lo - 1e-9 && r.pos <= hi + 1e-9);
    const perLine = new Map<string, LinearFit | null>();
    lines.forEach((line) => {
      const key = seriesKey(line);
      perLine.set(line.id, linearFit(inRange.map((r) => ({ x: r.pos, y: r[key] }))));
    });
    return { lo, hi, perLine };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, gradientRange, linesKey]);

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
  const yAxis = niceTemperatureAxis(yMin, yMax);

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

  // Displayed gradient for a line: °/cm when its real length is calibrated, else °/pixel from the frame
  // dimensions. null when there's no fit, or no way to scale (frame not decoded and length uncalibrated).
  const gradientReadout = (line: ProfileLine, fit: LinearFit | null): { value: number; unit: string } | null => {
    if (!fit) return null;
    const cm = calibratedCm(line);
    if (cm) return { value: fit.slope / cm, unit: `${unit}/cm` };
    if (frameDims) {
      const px = linePixelLength(line, frameDims.width, frameDims.height);
      if (px > 1e-6) return { value: fit.slope / px, unit: `${unit}/px` };
    }
    return null;
  };

  // Gradient readout — rendered as a strip BELOW the plot (not an overlay), so it never covers the curves;
  // the plot shrinks to make room. One entry per transect: slope (°/cm calibrated, else °/px), ΔT across
  // the selection, R², and an inline real-length input. Entries flow-wrap, so on the maximized chart (the
  // only place the tool runs — arming maximizes it) several usually share one row and the strip stays a
  // couple of lines tall. Part of the chart-container, so it's in the PNG export.
  const gradientPanel = gradientMode ? (
    <div
      className="profile-gradient-readout"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        flex: '0 0 auto',
        maxHeight: '46%',
        overflow: 'auto',
        borderTop: '1px solid #e6e6e6',
        padding: '5px 8px 6px',
        fontSize: 12,
        lineHeight: 1.45,
        color: '#222',
      }}
    >
      <div style={{ marginBottom: 3 }}>
        <span style={{ fontWeight: 700 }}>Gradient (dT/dx)</span>
        <span style={{ color: '#999', marginLeft: 8, fontSize: 11 }}>
          drag to narrow the interval (click to reset) · enter a line’s real length for °/cm
        </span>
      </div>
      {fits && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, rowGap: 3 }}>
          {lines.map((line, i) => {
            const fit = fits.perLine.get(line.id) ?? null;
            const g = gradientReadout(line, fit);
            // ΔT = temperature change across the selection (slope × span) — needs no calibration.
            const dT = fit ? fit.slope * (fits.hi - fits.lo) : null;
            return (
              <span
                key={line.id}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}
              >
                <span
                  style={{ width: 9, height: 9, borderRadius: '50%', background: profileColor(i), flex: '0 0 auto' }}
                />
                <span style={{ fontWeight: 600 }}>{nameFor(line)}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  {g ? `${fmtSlope(g.value)} ${g.unit}` : '—'}
                </span>
                {dT != null && (
                  <span
                    style={{ color: '#555', fontVariantNumeric: 'tabular-nums' }}
                  >{`ΔT ${fmtDelta(dT)}${unit}`}</span>
                )}
                {fit && <span style={{ color: '#999' }}>{`R²${fit.r2.toFixed(2)}`}</span>}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <InputNumber
                    size="small"
                    min={0}
                    step={0.5}
                    value={calibratedCm(line)}
                    placeholder="length"
                    controls={false}
                    title="This line's real length — switches its slope from °/px to °/cm"
                    style={{ width: 70 }}
                    onChange={(v) =>
                      updateProfileLine(expId, { ...line, lengthCm: typeof v === 'number' && v > 0 ? v : undefined })
                    }
                  />
                  <span style={{ color: '#888' }}>cm</span>
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div
      className="chart-container"
      // userSelect none while the gradient tool is armed: a drag that begins on the axis tick text (just
      // outside the plot area, where the mousedown handler can't preventDefault) must not text-select the
      // labels / readout strip as it sweeps.
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        userSelect: gradientMode ? 'none' : undefined,
      }}
      ref={containerRef}
    >
      {data.length > 0 && (
        <ChartMenu
          onSavePNG={() =>
            containerRef.current && exportElementToPNG(containerRef.current, timestampedName('lineprofile', 'png'))
          }
          onExportCSV={exportCSV}
          maximized={maximized}
          onToggleMaximize={() => setMaximizedChart(maximized ? null : ExperimentGraphOption.lineProfile)}
          gradientActive={gradientMode}
          onToggleGradient={() => setGradientMode(!gradientMode)}
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

      <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
        <ResponsiveContainer width="100%" height={'100%'}>
          <LineChart
            data={data}
            margin={CHART_MARGIN}
            // Crosshair while the gradient tool is armed — the cue that the chart is drag-selectable (same
            // affordance as the image overlay's draw mode). Must go through recharts' style prop: its
            // wrapper div carries an inline `cursor: default` that overrides any cursor set on an ancestor.
            style={{ cursor: gradientMode ? 'crosshair' : undefined }}
            // In gradient mode a press-drag defines the fit interval; otherwise a plain move mirrors the hovered
            // position onto the image overlay as a probe dot. activeLabel is the X value (position 0→1) under
            // the cursor.
            onMouseDown={(s, e: { preventDefault?: () => void } | undefined) => {
              if (!gradientMode) return;
              const pos = clampPos(s?.activeLabel);
              if (pos == null) return;
              // Stop the browser starting a native text selection from this press — without it the drag
              // highlights the axis tick labels / readout strip as it sweeps (mousedown's default action).
              e?.preventDefault?.();
              dragStartRef.current = pos;
              setHoveredProfilePos(pos); // probe dot marks the press point on the image right away
            }}
            onMouseMove={(s) => {
              const pos = clampPos(s?.activeLabel);
              // Mirror the pointer onto the image overlay (probe dot on each transect) — during a gradient
              // drag too, so the moving selection edge is visible on the physical line as it sweeps.
              setHoveredProfilePos(pos);
              if (dragStartRef.current != null && pos != null) setGradientRange([dragStartRef.current, pos]);
            }}
            onMouseUp={(s) => {
              if (dragStartRef.current == null) return;
              const start = dragStartRef.current;
              dragStartRef.current = null;
              const end = clampPos(s?.activeLabel) ?? start;
              // Too short a drag reads as a click → reset to the full-span default; otherwise commit the
              // ordered interval.
              if (Math.abs(end - start) < MIN_GRADIENT_SPAN) setGradientRange([0, 1]);
              else setGradientRange([Math.min(start, end), Math.max(start, end)]);
            }}
            onMouseLeave={() => {
              setHoveredProfilePos(null);
              dragStartRef.current = null; // end any in-progress drag; the last committed range stays
            }}
          >
            <CartesianGrid horizontal={horizontalGrid} vertical={verticalGrid} />
            {/* Selection band for the gradient tool, drawn behind the curves. Skipped at the full-span
                default — a wash over the entire plot marks nothing; the band appears once a drag narrows
                the interval. */}
            {fits && !(fits.lo <= 0 && fits.hi >= 1) && (
              <ReferenceArea
                x1={fits.lo}
                x2={fits.hi}
                fill="rgba(19,124,124,0.12)"
                stroke="rgba(19,124,124,0.55)"
                strokeDasharray="3 3"
                ifOverflow="extendDomain"
              />
            )}
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
              domain={yAxis ? yAxis.domain : ['auto', 'auto']}
              ticks={yAxis?.ticks}
              width={Y_AXIS_WIDTH}
              padding={{ top: 12, bottom: 12 }}
              tickFormatter={yTickFormatter(yAxis?.ticks)}
            >
              <Label content={renderYAxisTitle(`T (${unit})`)} />
            </YAxis>
            <Tooltip content={<ProfileTooltip unit={unit} />} />
            {lines.length > 1 && <Legend verticalAlign="top" height={24} />}
            {lines.map((line, i) => {
              const emphasized = hoveredLineId != null && line.id === hoveredLineId;
              const opacity = hoveredLineId != null && !emphasized ? 0.2 : 1;
              return (
                <Line
                  key={line.id}
                  type="monotone"
                  dataKey={seriesKey(line)}
                  name={nameFor(line)}
                  stroke={profileColor(i)}
                  strokeWidth={emphasized ? lineWidth + 1 : lineWidth}
                  strokeOpacity={opacity}
                  dot={false}
                  isAnimationActive={false}
                />
              );
            })}
            {/* Fitted regression line per transect over the selected interval, drawn on top of the curves. */}
            {fits &&
              lines.map((line, i) => {
                const fit = fits.perLine.get(line.id);
                if (!fit) return null;
                return (
                  <ReferenceLine
                    key={`fit-${line.id}`}
                    stroke={profileColor(i)}
                    strokeWidth={2.5}
                    strokeDasharray="7 4"
                    ifOverflow="extendDomain"
                    segment={[
                      { x: fits.lo, y: fit.slope * fits.lo + fit.intercept },
                      { x: fits.hi, y: fit.slope * fits.hi + fit.intercept },
                    ]}
                  />
                );
              })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {gradientPanel}
    </div>
  );
};

export default ProfilePlot;
