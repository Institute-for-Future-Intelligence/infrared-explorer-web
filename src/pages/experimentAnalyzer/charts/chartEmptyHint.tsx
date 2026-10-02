import { ReactNode } from 'react';
import { CHART_MARGIN, Y_AXIS_WIDTH } from '../../../utils/constants';

/**
 * The hint a chart shows while it has nothing to plot but still draws its empty axes and grid (T(t) /
 * T(x) / T(y) before a thermometer, T(l) before its first line): centred over the plot area — inside the axis
 * bands, sized from the chart margins (30 = recharts' default X-axis height) — and inert. Inside the
 * chart's container, so it rides along into a PNG export like the axes do. White on the player (App.css).
 */
const ChartEmptyHint = ({ children }: { children: ReactNode }) => (
  <div
    className="chart-empty-hint"
    style={{
      top: CHART_MARGIN.top,
      right: CHART_MARGIN.right,
      bottom: CHART_MARGIN.bottom + 30,
      left: Y_AXIS_WIDTH,
    }}
  >
    {children}
  </div>
);

export default ChartEmptyHint;
