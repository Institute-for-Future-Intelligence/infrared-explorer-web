import { Checkbox, Dropdown, Slider } from 'antd';
import { MenuOutlined } from '@ant-design/icons';

/** Live chart-display controls shown in the menu (telelab parity). Optional — charts that
 * only need save actions can omit it and the menu falls back to save-only. Within `controls`,
 * the symbol sliders (line plot) and the error-bars toggle (scatter) are each optional, so a
 * chart only surfaces the options that apply to it. */
export interface ChartControls {
  lineWidth: number;
  onLineWidth: (v: number) => void;
  // Symbol controls — line plot only; omit on scatter.
  symbolCount?: number;
  symbolCountMax?: number;
  onSymbolCount?: (v: number) => void;
  symbolSize?: number;
  onSymbolSize?: (v: number) => void;
  // Error bars — scatter plot only; omit on line plot.
  errorBars?: boolean;
  onErrorBars?: (v: boolean) => void;
  horizontalGrid: boolean;
  onHorizontalGrid: (v: boolean) => void;
  verticalGrid: boolean;
  onVerticalGrid: (v: boolean) => void;
}

interface Props {
  onSavePNG: () => void;
  onExportCSV: () => void;
  controls?: ChartControls;
}

/**
 * Per-chart hamburger menu, pinned top-right. Offers Save as CSV / Save as Image and, when
 * `controls` are supplied, telelab-style line/symbol/grid display options. Marked
 * `data-html2canvas-ignore` so the button itself is excluded from the chart's PNG export.
 */
const ChartMenu = ({ onSavePNG, onExportCSV, controls }: Props) => {
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
          <div className="chart-menu-control">
            <span className="chart-menu-label">Line Width:</span>
            <Slider min={1} max={8} step={0.5} value={controls.lineWidth} onChange={controls.onLineWidth} />
          </div>

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
    <div data-html2canvas-ignore style={{ position: 'absolute', right: 4, top: 4, zIndex: 1 }}>
      <Dropdown trigger={['click']} placement="bottomRight" dropdownRender={() => panel}>
        <MenuOutlined
          title="Chart options"
          style={{
            fontSize: 13,
            padding: '3px 6px',
            cursor: 'pointer',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.5)',
            color: 'white',
          }}
        />
      </Dropdown>
    </div>
  );
};

export default ChartMenu;
