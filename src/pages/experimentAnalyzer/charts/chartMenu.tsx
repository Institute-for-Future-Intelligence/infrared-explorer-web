import { Checkbox, Dropdown, Slider } from 'antd';
import { CompressOutlined, ExpandOutlined, MenuOutlined, RiseOutlined } from '@ant-design/icons';
import { CHART_MARGIN } from '../../../utils/constants';

/** Live chart-display controls shown in the menu (telelab parity). Optional — charts that
 * only need save actions can omit it and the menu falls back to save-only. Within `controls`,
 * the symbol sliders (line plot) and the error-bars toggle (scatter) are each optional, so a
 * chart only surfaces the options that apply to it. */
export interface ChartControls {
  // Line width — line / scatter / profile plots; omit on the histogram (its marks are bars, not lines).
  lineWidth?: number;
  onLineWidth?: (v: number) => void;
  // Bin count — histogram only; omit elsewhere.
  bins?: number;
  binsMin?: number;
  binsMax?: number;
  onBins?: (v: number) => void;
  // Symbol controls — line plot only; omit on scatter.
  symbolCount?: number;
  symbolCountMax?: number;
  onSymbolCount?: (v: number) => void;
  symbolSize?: number;
  onSymbolSize?: (v: number) => void;
  // Error bars — scatter plot only; omit on line plot.
  errorBars?: boolean;
  onErrorBars?: (v: boolean) => void;
  // Whole-frame min/max/mean overlay — line plot only; omit on scatter.
  frameStats?: boolean;
  onFrameStats?: (v: boolean) => void;
  horizontalGrid: boolean;
  onHorizontalGrid: (v: boolean) => void;
  verticalGrid: boolean;
  onVerticalGrid: (v: boolean) => void;
}

interface Props {
  onSavePNG: () => void;
  onExportCSV: () => void;
  controls?: ChartControls;
  // Maximize / restore this chart to fill the Charts panel. Omit to hide the button.
  maximized?: boolean;
  onToggleMaximize?: () => void;
  // T(l) gradient tool (dT/dx) toggle — profile chart only. Omit both to hide the button.
  gradientActive?: boolean;
  onToggleGradient?: () => void;
}

// Shared look for the top-right icon buttons (a dark chip so they read over any chart background).
const ICON_STYLE = {
  fontSize: 13,
  padding: '3px 6px',
  cursor: 'pointer',
  borderRadius: 4,
  background: 'rgba(0,0,0,0.5)',
  color: 'white',
} as const;

/**
 * Per-chart controls, pinned top-right: an optional maximize / restore toggle and a hamburger menu
 * offering Save as CSV / Save as Image and, when `controls` are supplied, telelab-style
 * line/symbol/grid display options. Marked `data-html2canvas-ignore` so the buttons are excluded
 * from the chart's PNG export.
 */
const ChartMenu = ({
  onSavePNG,
  onExportCSV,
  controls,
  maximized,
  onToggleMaximize,
  gradientActive,
  onToggleGradient,
}: Props) => {
  // Stop clicks inside the panel from bubbling to the document and closing the dropdown,
  // so dragging sliders / toggling checkboxes keeps the menu open.
  const panel = (
    <div className="chart-menu-panel" onClick={(e) => e.stopPropagation()}>
      <div className="chart-menu-action" onClick={onExportCSV}>
        Save as CSV
      </div>
      <div className="chart-menu-action" onClick={onSavePNG}>
        Save as Image
      </div>

      {controls && (
        <>
          {controls.onBins && (
            <div className="chart-menu-control">
              <span className="chart-menu-label">Bins:</span>
              <Slider
                min={controls.binsMin ?? 10}
                max={controls.binsMax ?? 100}
                step={1}
                value={controls.bins}
                onChange={controls.onBins}
              />
            </div>
          )}

          {controls.onLineWidth && (
            <div className="chart-menu-control">
              <span className="chart-menu-label">Line Width:</span>
              <Slider min={1} max={8} step={0.5} value={controls.lineWidth} onChange={controls.onLineWidth} />
            </div>
          )}

          {controls.onSymbolCount && (
            <div className="chart-menu-control">
              <span className="chart-menu-label">Symbol Count:</span>
              <Slider
                min={0}
                max={controls.symbolCountMax}
                step={1}
                value={controls.symbolCount}
                onChange={controls.onSymbolCount}
              />
            </div>
          )}

          {controls.onSymbolSize && (
            <>
              <div className="chart-menu-divider" />
              <div className="chart-menu-control">
                <span className="chart-menu-label">Symbol Size:</span>
                <Slider min={1} max={10} step={0.5} value={controls.symbolSize} onChange={controls.onSymbolSize} />
              </div>
            </>
          )}

          <div className="chart-menu-divider" />

          {controls.onErrorBars && (
            <Checkbox checked={controls.errorBars} onChange={(e) => controls.onErrorBars?.(e.target.checked)}>
              Error Bars
            </Checkbox>
          )}
          {controls.onFrameStats && (
            <Checkbox checked={controls.frameStats} onChange={(e) => controls.onFrameStats?.(e.target.checked)}>
              Frame min / max / mean
            </Checkbox>
          )}
          <Checkbox checked={controls.horizontalGrid} onChange={(e) => controls.onHorizontalGrid(e.target.checked)}>
            Horizontal Grid Lines
          </Checkbox>
          <Checkbox checked={controls.verticalGrid} onChange={(e) => controls.onVerticalGrid(e.target.checked)}>
            Vertical Grid Lines
          </Checkbox>
        </>
      )}
    </div>
  );

  return (
    // Right edge lines up with the plot area's right edge; vertically the cluster sits in the
    // title band CHART_MARGIN.top reserves above the plot (same row as the Y-axis title), so the
    // buttons no longer cover the top of the chart.
    <div
      data-html2canvas-ignore
      style={{
        position: 'absolute',
        right: CHART_MARGIN.right,
        top: 2,
        zIndex: 1,
        display: 'flex',
        gap: 4,
      }}
    >
      {onToggleGradient && (
        <RiseOutlined
          title={gradientActive ? 'Exit gradient tool' : 'Gradient tool — drag on the chart to fit dT/dx'}
          style={gradientActive ? { ...ICON_STYLE, background: 'rgba(19,124,124,0.92)' } : ICON_STYLE}
          onClick={onToggleGradient}
        />
      )}
      {onToggleMaximize &&
        (maximized ? (
          <CompressOutlined title="Restore chart" style={ICON_STYLE} onClick={onToggleMaximize} />
        ) : (
          <ExpandOutlined title="Maximize chart" style={ICON_STYLE} onClick={onToggleMaximize} />
        ))}
      <Dropdown trigger={['click']} placement="bottomRight" popupRender={() => panel}>
        <MenuOutlined title="Chart options" style={ICON_STYLE} />
      </Dropdown>
    </div>
  );
};

export default ChartMenu;
