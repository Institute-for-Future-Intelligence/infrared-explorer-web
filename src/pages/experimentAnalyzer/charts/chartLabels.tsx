import { ReactNode } from 'react';

// Mirrors recharts' `ViewBox` (CartesianViewBox | PolarViewBox). Typing the render-prop param as
// this union — rather than the cartesian shape alone — keeps it assignable to recharts' content
// type (an all-optional "weak" cartesian type would reject the polar half of the union).
type ViewBoxLike = { x?: number; y?: number; width?: number; height?: number } | { cx?: number; cy?: number };

/**
 * Render-prop for a recharts `<YAxis><Label>` that draws the rotated temperature title at a fixed
 * x — 14px in from the axis band's LEFT edge (`viewBox.x`) — independent of the tick-label width.
 *
 * Why not `position="center"` + `dx`: recharts centers an axis Label in the axis band
 * (x = viewBox.x + width/2), which is exactly where the right-aligned tick numbers sit and grow
 * leftward, so the title overlaps them no matter how wide the band is (widening the band shifts the
 * centered title by the same amount). Anchoring to `viewBox.x` instead keeps the title in the left
 * gutter: clear of the ticks, and — since the gutter is left of the plot area — clear of the data
 * lines on the line plot too. The `<text>` is rendered inside the chart SVG, so html2canvas still
 * captures it in the "Save as Image" export.
 */
export const renderYAxisTitle =
  (label: string) =>
  ({ viewBox }: { viewBox?: ViewBoxLike }): ReactNode => {
    if (!viewBox || !('x' in viewBox) || viewBox.x == null || viewBox.y == null || viewBox.height == null) return null;
    const x = viewBox.x + 14;
    const y = viewBox.y + viewBox.height / 2;
    return (
      <text
        x={x}
        y={y}
        transform={`rotate(-90, ${x}, ${y})`}
        textAnchor="middle"
        dominantBaseline="central"
        className="recharts-text recharts-label"
        fill="#666"
        fontSize={12}
      >
        {label}
      </text>
    );
  };
