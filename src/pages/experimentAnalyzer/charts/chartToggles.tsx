import TimeGraphSVG from '../../../assets/time_graph.svg?react';
import XGraphSVG from '../../../assets/x_graph.svg?react';
import YGraphSVG from '../../../assets/y_graph.svg?react';
import LGraphSVG from '../../../assets/l_graph.svg?react';
import HistGraphSVG from '../../../assets/hist_graph.svg?react';
import useCommonStore, { MAX_VISIBLE_CHARTS } from '../../../stores/common';
import { ExperimentGraphOption } from '../../../types';

interface Props {
  expId: string;
  graphsOptions: ExperimentGraphOption[] | undefined;
  // Drop the T(t) chip (a photo set has no time axis — see ChartManager.hideTime).
  hideTime?: boolean;
}

// The plottable graph types, each a labelled chip. These toggles used to live on the player's left
// toolbar; they act only on the right-hand panel, so they belong here — right where the plot appears (and
// the labels spell out what the T(t)/T(x)/T(y) glyphs mean for a first-time student). The whole-frame
// min/max/mean is not its own chip: it overlays the T(t) plot via that plot's menu toggle.
const CHIPS = [
  { option: ExperimentGraphOption.time, Img: TimeGraphSVG, label: 'T(t)', sub: 'over time' },
  { option: ExperimentGraphOption.spaceX, Img: XGraphSVG, label: 'T(x)', sub: 'across width' },
  { option: ExperimentGraphOption.spaceY, Img: YGraphSVG, label: 'T(y)', sub: 'across height' },
  { option: ExperimentGraphOption.lineProfile, Img: LGraphSVG, label: 'T(l)', sub: 'along a line' },
  { option: ExperimentGraphOption.histogram, Img: HistGraphSVG, label: 'N(T)', sub: 'distribution' },
] as const;

// A chip row pinned above the charts: pick which of T(t)/T(x)/T(y) to plot. Toggling writes to the
// experiment's graphsOptions (owner edits autosave); it never changes the workspace tab, since the
// user is already looking at the Charts panel.
const ChartToggles = ({ expId, graphsOptions, hideTime = false }: Props) => {
  const toggleGraphOption = useCommonStore((state) => state.toggleGraphOption);
  const chips = hideTime ? CHIPS.filter((c) => c.option !== ExperimentGraphOption.time) : CHIPS;
  // The plots share a 2×2 grid, so only MAX_VISIBLE_CHARTS can show at once. Once that many are on, the
  // inactive chips are disabled (an active chip stays clickable so you can turn one off to free a slot).
  const activeCount = chips.reduce((n, { option }) => (graphsOptions?.includes(option) ? n + 1 : n), 0);
  const atCap = activeCount >= MAX_VISIBLE_CHARTS;
  return (
    <div className="chart-toggles" role="group" aria-label="Choose graphs to plot">
      {chips.map(({ option, Img, label, sub }) => {
        const active = !!graphsOptions?.includes(option);
        const disabled = !active && atCap;
        // In a narrow workspace the chip sheds its sub-label and icon (App.css @container tiers), so the
        // full wording is pinned here: aria-label keeps the accessible name whole regardless of what's
        // visually hidden, and the title makes the dropped sub-label hoverable again.
        return (
          <button
            key={option}
            type="button"
            className={active ? 'chart-toggle chart-toggle-active' : 'chart-toggle'}
            aria-pressed={active}
            aria-label={`${label} ${sub}`}
            disabled={disabled}
            title={
              disabled ? `Show up to ${MAX_VISIBLE_CHARTS} graphs at once — turn one off first.` : `${label} — ${sub}`
            }
            onClick={() => toggleGraphOption(expId, option)}
          >
            <Img className="chart-toggle-icon" aria-hidden />
            <span className="chart-toggle-text">
              <span className="chart-toggle-label">{label}</span>
              <span className="chart-toggle-sub">{sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default ChartToggles;
