import { ReactNode } from 'react';

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
 * html2canvas still captures it in the "Save as Image" export.
 */
export const renderYAxisTitle =
  (label: string) =>
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
