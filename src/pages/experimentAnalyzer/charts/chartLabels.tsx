import { ReactNode, SVGProps } from 'react';

// Text drawn straight over the thermal frame: a see-through white with a faint dark outline painted under
// the fill — light enough to sit quietly on the picture, the outline still keeping it legible on a pale
// palette. Inline SVG presentation props, not CSS — html2canvas only carries a chart's inline colours
// into a PNG export.
const PLAYER_TEXT = {
  fill: '#fff',
  fillOpacity: 0.75,
  stroke: '#000',
  strokeOpacity: 0.3,
  strokeWidth: 2,
  strokeLinejoin: 'round',
  paintOrder: 'stroke',
} as const;

/**
 * A chart's chrome — axes and their tick labels, axis titles, grid, neutral marks. In the Charts panel
 * the plot sits on the white card and recharts' own greys are right, so every field is empty. Laid over
 * the player (useChartOverlay's `active`) there is no panel behind it, only the frame, and the chrome
 * turns white: `axis` spreads onto XAxis / YAxis, `grid` onto CartesianGrid, `text` onto an axis title,
 * and `neutral` replaces a chart's grey helper strokes.
 */
export const chartChrome = (onPlayer: boolean) =>
  onPlayer
    ? {
        axis: { stroke: '#fff', tick: PLAYER_TEXT },
        grid: { stroke: 'rgba(255, 255, 255, 0.4)' },
        text: PLAYER_TEXT,
        neutral: '#fff',
      }
    : { axis: {}, grid: {}, text: {}, neutral: undefined };

// Mirrors recharts' `ViewBox` (CartesianViewBox | PolarViewBox). Typing the render-prop param as
// this union — rather than the cartesian shape alone — keeps it assignable to recharts' content
// type (an all-optional "weak" cartesian type would reject the polar half of the union).
type ViewBoxLike = { x?: number; y?: number; width?: number; height?: number } | { cx?: number; cy?: number };

/**
 * Render-prop for a recharts `<YAxis><Label>` that draws the axis title horizontally at the TOP of
 * the tick column, in the band `CHART_MARGIN.top` reserves above the plot — instead of the classic
 * rotated-90° title, whose dedicated left gutter cost ~28px of plot width on every chart. Anchored
 * to the axis band's left edge (`viewBox.x`) with the baseline just above the plot top, it clears
 * both the topmost tick label and the data. The `<text>` is rendered inside the chart SVG, so
 * html2canvas still captures it in the "Save as Image" export. `textProps` restyles it (chartChrome's
 * `text`, for a chart laid over the player).
 */
export const renderYAxisTitle =
  (label: string, textProps: SVGProps<SVGTextElement> = {}) =>
  ({ viewBox }: { viewBox?: ViewBoxLike }): ReactNode => {
    if (!viewBox || !('x' in viewBox) || viewBox.x == null || viewBox.y == null) return null;
    return (
      <text
        x={viewBox.x + 2}
        y={viewBox.y - 10}
        textAnchor="start"
        className="recharts-text recharts-label"
        fill="#666"
        fontSize={12}
        {...textProps}
      >
        {label}
      </text>
    );
  };

/**
 * Tick formatter for the temperature Y axes: whole numbers when every tick is whole (the usual
 * case — the nice-tick steps are 1/2/5/10…), one decimal otherwise (0.5-degree steps). Keeps the
 * narrow axis band tidy instead of forcing a ".0" onto every label.
 */
export const yTickFormatter = (ticks?: number[]) => {
  const decimals = ticks?.length && ticks.every((t) => Number.isInteger(t)) ? 0 : 1;
  return (v: number) => v.toFixed(decimals);
};
