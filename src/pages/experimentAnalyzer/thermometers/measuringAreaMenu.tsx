import type { MenuProps } from 'antd';
import { Radio } from 'antd';
import { MeasuringAreaType, Thermometer } from '../../../types';

// Vertical radio list inside the "Measuring Area" submenu (mirrors telelab's radioStyle).
const radioStyle = { display: 'block', height: 30, lineHeight: '30px', paddingLeft: 10 };

/**
 * "Measuring Area" submenu (Point / Rectangle / Ellipse) for the player right-click menu.
 * Pre-selects the thermometer's current type and calls `onPick` with the chosen one.
 * Returns null when no thermometer is selected so the caller can omit it.
 */
export const measuringAreaSubmenuItem = (
  thermometer: Thermometer | undefined,
  onPick: (type: MeasuringAreaType) => void,
): NonNullable<MenuProps['items']>[number] | null => {
  if (!thermometer) return null;
  return {
    key: 'measuringArea',
    label: 'Measuring Area',
    children: [
      {
        key: 'measuringArea-radios',
        // Static container for the radios — inline bg overrides antd's hover highlight on the row.
        style: { backgroundColor: 'transparent', cursor: 'default' },
        label: (
          <Radio.Group
            value={thermometer.measuringAreaType ?? MeasuringAreaType.Point}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onPick(e.target.value)}
          >
            <Radio style={radioStyle} value={MeasuringAreaType.Point}>
              Point
            </Radio>
            <Radio style={radioStyle} value={MeasuringAreaType.Rectangle}>
              Rectangle
            </Radio>
            <Radio style={radioStyle} value={MeasuringAreaType.Ellipse}>
              Ellipse
            </Radio>
          </Radio.Group>
        ),
      },
    ],
  };
};
