import useCommonStore from '../../../stores/common';
import { PRESET_COLORS, SERIES_SHAPES } from '../../../utils/constants';

interface Props {
  thermometersId: string[];
}

// A short coloured line with the series' marker centred on it — bridges the T(t) line encoding and the
// T(x)/T(y) scatter symbols, so a single swatch identifies a thermometer across all three plots.
const KeySwatch = ({ color, shape }: { color: string; shape: (typeof SERIES_SHAPES)[number] }) => {
  const c = 9; // centre of the 18×18 box
  const s = 4;
  let marker: JSX.Element;
  switch (shape) {
    case 'square':
      marker = <rect x={c - s} y={c - s} width={2 * s} height={2 * s} fill={color} />;
      break;
    case 'triangle':
      marker = <polygon points={`${c},${c - s} ${c - s},${c + s} ${c + s},${c + s}`} fill={color} />;
      break;
    case 'diamond':
      marker = <polygon points={`${c},${c - s} ${c + s},${c} ${c},${c + s} ${c - s},${c}`} fill={color} />;
      break;
    case 'cross':
      marker = (
        <g stroke={color} strokeWidth={2}>
          <line x1={c - s} y1={c} x2={c + s} y2={c} />
          <line x1={c} y1={c - s} x2={c} y2={c + s} />
        </g>
      );
      break;
    default:
      marker = <circle cx={c} cy={c} r={s} fill={color} />;
  }
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
      <line x1={1} y1={c} x2={17} y2={c} stroke={color} strokeWidth={2} />
      {marker}
    </svg>
  );
};

// One shared colour key for the thermometer-coloured plots (T(t), T(x), T(y)). It replaces the per-plot
// legend that used to eat the T(t) chart's height: the T1…T7 colour↔thermometer mapping is identical
// across those plots, so it's shown once above the grid instead of inside each chart. Colour/shape are
// keyed by the thermometer's positional index (matching the scatter symbols, and the T(t) lines whenever
// every id is present). Hovering a chip emphasises that thermometer across every plot — the same hover
// channel the image's thermometer list uses (hoveredThermometerId).
const ChartColorKey = ({ thermometersId }: Props) => {
  const thermometerMap = useCommonStore((state) => state.thermometerMap);
  const hoveredId = useCommonStore((state) => state.hoveredThermometerId);
  const hoverThermometer = useCommonStore((state) => state.hoverThermometer);

  const items = thermometersId
    .map((id, i) => ({ id, thermometer: thermometerMap.get(id), i }))
    .filter((x) => x.thermometer !== undefined)
    .map(({ id, thermometer, i }) => ({
      id,
      name: thermometer?.name?.trim() || `T${i + 1}`,
      color: PRESET_COLORS[i % PRESET_COLORS.length],
      shape: SERIES_SHAPES[i % SERIES_SHAPES.length],
    }));

  if (items.length === 0) return null;

  return (
    <div className="chart-color-key" role="list" aria-label="Thermometer colour key">
      {items.map((it) => (
        <span
          key={it.id}
          role="listitem"
          className="chart-color-key-item"
          style={{ opacity: hoveredId != null && hoveredId !== it.id ? 0.35 : 1 }}
          onMouseEnter={() => hoverThermometer(it.id)}
          onMouseLeave={() => hoverThermometer(null)}
        >
          <KeySwatch color={it.color} shape={it.shape} />
          <span className="chart-color-key-label">{it.name}</span>
        </span>
      ))}
    </div>
  );
};

export default ChartColorKey;
