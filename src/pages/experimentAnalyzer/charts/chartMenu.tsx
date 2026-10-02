import { Button, Checkbox, Dropdown, InputNumber, Slider } from 'antd';
import { ReactNode, useEffect, useState } from 'react';
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  CloseOutlined,
  CompressOutlined,
  ExpandOutlined,
  FunctionOutlined,
  MenuOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import { CHART_MARGIN } from '../../../utils/constants';
import { MAX_OVERLAY_CHARTS, MAX_VISIBLE_CHARTS } from '../../../stores/common';
import { ExperimentGraphOption } from '../../../types';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { ChartOverlayControl, useChartClose, useChartOverlay } from './useChartOverlay';

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
  // X-axis (temperature) range, in the display unit — histogram only. `null` = AUTO; `auto` is what AUTO
  // currently resolves to (shown in the box while that end is AUTO). onRange(null, null) resets to AUTO.
  range?: { min: number | null; max: number | null; auto: [number, number]; unit: string };
  onRange?: (min: number | null, max: number | null) => void;
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
  // The options menu (☰): its save actions, plus the display `controls`. Omit the saves while there's
  // nothing plotted yet — the ☰ then stays out of the row.
  onSavePNG?: () => void;
  onExportCSV?: () => void;
  controls?: ChartControls;
  // Maximize / restore this chart to fill the Charts panel. Omit to hide the button.
  maximized?: boolean;
  onToggleMaximize?: () => void;
  // T(l) gradient tool (dT/dx) toggle — profile chart only. Omit both to hide the button.
  gradientActive?: boolean;
  onToggleGradient?: () => void;
  // T(t) cooling/heating curve-fit tool toggle — line chart only. Omit both to hide the button.
  fitActive?: boolean;
  onToggleFit?: () => void;
  // Move this chart onto the player and back (useChartOverlay). Omit to hide the button. While the chart
  // is ON the player the row keeps the fit / gradient toggle, the options menu and the close; maximize
  // (a panel-only view) goes.
  overlay?: ChartOverlayControl;
  // Turn the chart off — the ✕ in the corner, same as its chip (useChartClose). Omit to hide it.
  onClose?: () => void;
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
// A button that can't act right now (the move to / from the player at a cap): dimmed, still clickable —
// the click explains why.
const BLOCKED_ICON_STYLE = { ...ICON_STYLE, opacity: 0.45 } as const;

const round1 = (v: number) => Number(v.toFixed(1));

/**
 * Min / max inputs for a chart's X range. Each box always shows the range actually drawn (the stored value,
 * or what AUTO resolves to). Clicking a box's up/down arrows applies at once; typed text is held locally and
 * applied on Enter / blur, so a half-typed value ("-", "1" on the way to "15") never reaches the chart.
 * Clearing a box returns that end to AUTO; a value that would make min ≥ max is rejected (the box snaps back).
 */
const RangeControl = ({
  range,
  onRange,
}: {
  range: NonNullable<ChartControls['range']>;
  onRange: (min: number | null, max: number | null) => void;
}) => {
  const shownMin = round1(range.min ?? range.auto[0]);
  const shownMax = round1(range.max ?? range.auto[1]);
  const [min, setMin] = useState<number | null>(shownMin);
  const [max, setMax] = useState<number | null>(shownMax);
  useEffect(() => setMin(shownMin), [shownMin]);
  useEffect(() => setMax(shownMax), [shownMax]);

  // Apply one end (null = back to AUTO), leaving the other end's stored value (possibly AUTO) untouched.
  const applyMin = (v: number | null) => {
    if (v === shownMin && range.min !== null) return;
    if (v !== null && v >= shownMax) return setMin(shownMin);
    if (v === null && range.min === null) return setMin(shownMin);
    onRange(v, range.max);
  };
  const applyMax = (v: number | null) => {
    if (v === shownMax && range.max !== null) return;
    if (v !== null && v <= shownMin) return setMax(shownMax);
    if (v === null && range.max === null) return setMax(shownMax);
    onRange(range.min, v);
  };
  // Blur / Enter after typing: a box left at the value it already showed is a no-op (so merely focusing an
  // AUTO box doesn't pin it).
  const commitMin = () => (min === shownMin ? undefined : applyMin(min));
  const commitMax = () => (max === shownMax ? undefined : applyMax(max));

  return (
    <div className="chart-menu-control">
      <span className="chart-menu-label">Temperature Range ({range.unit}):</span>
      <div style={{ display: 'flex', alignItems: 'center', margin: '4px 0' }}>
        <InputNumber
          size="small"
          style={{ width: 80 }}
          value={min}
          step={1}
          precision={1}
          onChange={(v) => setMin(v ?? null)}
          onStep={(v) => applyMin(round1(Number(v)))}
          onBlur={commitMin}
          onPressEnter={commitMin}
        />
        <span style={{ margin: '0 6px' }}>–</span>
        <InputNumber
          size="small"
          style={{ width: 80 }}
          value={max}
          step={1}
          precision={1}
          onChange={(v) => setMax(v ?? null)}
          onStep={(v) => applyMax(round1(Number(v)))}
          onBlur={commitMax}
          onPressEnter={commitMax}
        />
        <Button
          size="small"
          type="link"
          disabled={range.min === null && range.max === null}
          onClick={() => onRange(null, null)}
        >
          Auto
        </Button>
      </div>
    </div>
  );
};

/**
 * Per-chart controls, pinned top-right: the tool toggles (gradient / fit), the move to / from the player,
 * maximize / restore, a hamburger menu offering Save as CSV / Save as Image and, when `controls` are
 * supplied, telelab-style line/symbol/grid display options — and the ✕ that turns the chart off, always
 * last, in the corner. The row shows only while the pointer is over the chart (App.css .chart-corner), or
 * while its menu is open; on a touch screen, with no hover, it always shows. Marked
 * `data-html2canvas-ignore` so the buttons are excluded from the chart's PNG export.
 */
const ChartMenu = ({
  onSavePNG,
  onExportCSV,
  controls,
  maximized,
  onToggleMaximize,
  gradientActive,
  onToggleGradient,
  fitActive,
  onToggleFit,
  overlay,
  onClose,
}: Props) => {
  const onPlayer = !!overlay?.active;
  // Held open while the options menu is: the pointer leaves the chart for the (portalled) menu. (Only
  // while the ☰ exists — one dropped mid-open must not pin the row up.)
  const hasMenu = !!(onSavePNG || onExportCSV);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();
  // The move button's arrow points where the chart goes: onto the player, left of the workspace — or
  // back to the workspace, right of the player. (Up / down on a phone, where the two are stacked.)
  const MoveArrow = onPlayer
    ? isMobile
      ? ArrowDownOutlined
      : ArrowRightOutlined
    : isMobile
      ? ArrowUpOutlined
      : ArrowLeftOutlined;
  const moveTitle = onPlayer
    ? overlay?.blocked
      ? `The Charts tab already shows ${MAX_VISIBLE_CHARTS} graphs — turn one off there first`
      : 'Move back to the Charts tab'
    : overlay?.blocked
      ? `The player already shows ${MAX_OVERLAY_CHARTS} charts — take one off first`
      : 'Show on the player, over the frame';
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

          {controls.onRange && controls.range && <RangeControl range={controls.range} onRange={controls.onRange} />}

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
    // buttons no longer cover the top of the chart. A flex row, so every chip hangs from its top edge.
    <div
      data-html2canvas-ignore
      className={menuOpen && hasMenu ? 'chart-corner is-open' : 'chart-corner'}
      style={{ position: 'absolute', right: CHART_MARGIN.right, top: 2, zIndex: 1, display: 'flex', gap: 4 }}
    >
      {onToggleGradient && (
        <RiseOutlined
          title={
            gradientActive ? 'Exit gradient tool' : 'Gradient (dT/dx) — draws a fitted line; drag to fit an interval'
          }
          style={gradientActive ? { ...ICON_STYLE, background: 'rgba(19,124,124,0.92)' } : ICON_STYLE}
          onClick={onToggleGradient}
        />
      )}
      {onToggleFit && (
        <FunctionOutlined
          title={
            fitActive ? 'Exit curve-fit tool' : 'Curve fit — draws a cooling/heating curve; drag to fit a time window'
          }
          style={fitActive ? { ...ICON_STYLE, background: 'rgba(19,124,124,0.92)' } : ICON_STYLE}
          onClick={onToggleFit}
        />
      )}
      {overlay && (
        <MoveArrow
          title={moveTitle}
          // Dimmed at a cap, but still clickable: the click says why (useChartOverlay).
          style={overlay.blocked ? BLOCKED_ICON_STYLE : ICON_STYLE}
          onClick={overlay.toggle}
        />
      )}
      {onToggleMaximize &&
        !onPlayer &&
        (maximized ? (
          <CompressOutlined title="Restore chart" style={ICON_STYLE} onClick={onToggleMaximize} />
        ) : (
          <ExpandOutlined title="Maximize chart" style={ICON_STYLE} onClick={onToggleMaximize} />
        ))}
      {hasMenu && (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          popupRender={() => panel}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        >
          <MenuOutlined title="Chart options" style={ICON_STYLE} />
        </Dropdown>
      )}
      {onClose && <CloseOutlined title="Hide this graph" style={ICON_STYLE} onClick={onClose} />}
    </div>
  );
};

/**
 * A chart's place while it has nothing to plot (its data still loading, or no line to sample yet): the
 * message, under the corner buttons that need no data — move it to / from the player, and close it — so a
 * chart has them from the moment its chip is on.
 */
export const ChartPlaceholder = ({
  expId,
  option,
  kind,
  children,
}: {
  expId: string;
  option: ExperimentGraphOption;
  kind: 'loading' | 'hint';
  children: ReactNode;
}) => {
  const overlay = useChartOverlay(expId, option);
  const onClose = useChartClose(expId, option);
  return (
    <div className={`chart-container chart-${kind}`} style={{ position: 'relative' }}>
      <ChartMenu overlay={overlay} onClose={onClose} />
      {children}
    </div>
  );
};

export default ChartMenu;
