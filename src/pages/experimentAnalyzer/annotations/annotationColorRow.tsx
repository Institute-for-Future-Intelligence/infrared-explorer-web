import { ColorPicker, Tooltip } from 'antd';
import { ANNOTATION_COLORS, annotationColorOf, storedAnnotationColor } from './annotationColor';

interface RowProps {
  /** The current colour (null = default). */
  value: string | null | undefined;
  onChange: (color: string | null) => void;
}

/**
 * The colour row of the Add / Edit Annotation dialog: the quick palette as round swatches, with a free
 * picker (antd's ColorPicker) at the end for any other colour. Plain buttons, so one click picks.
 */
export const AnnotationColorRow = ({ value, onChange }: RowProps) => {
  const current = annotationColorOf(value).toLowerCase();
  const inPalette = ANNOTATION_COLORS.some((c) => c.value === current);
  return (
    <div className="annotation-colors" role="radiogroup">
      {ANNOTATION_COLORS.map((c) => (
        <Tooltip key={c.value} title={c.name} mouseEnterDelay={0.4}>
          <button
            type="button"
            role="radio"
            aria-checked={current === c.value}
            aria-label={c.name}
            className={`annotation-swatch${current === c.value ? ' annotation-swatch--active' : ''}`}
            style={{ background: c.value }}
            onClick={() => onChange(storedAnnotationColor(c.value))}
          />
        </Tooltip>
      ))}
      <ColorPicker value={current} disabledAlpha onChange={(c) => onChange(storedAnnotationColor(c.toHexString()))}>
        <Tooltip title="Any other colour" mouseEnterDelay={0.4}>
          <button
            type="button"
            aria-label="Any other colour"
            className={`annotation-swatch annotation-swatch--custom${!inPalette ? ' annotation-swatch--active' : ''}`}
            style={!inPalette ? { background: current } : undefined}
          />
        </Tooltip>
      </ColorPicker>
    </div>
  );
};
