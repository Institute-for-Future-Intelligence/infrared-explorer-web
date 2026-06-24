import type { MenuProps } from 'antd';
import { Radio } from 'antd';
import { MeasuringAreaType, Thermometer } from '../../../types';

// Each option is a fixed-height row with its dot + label left-aligned, so the circles line up in a
// column; the whole group is then centred as a block in the popup (see the wrapper below).
const radioStyle = { display: 'flex', alignItems: 'center', height: 32, margin: 0 };

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
        // Take the row's layout over from antd: transparent (no hover), auto height for the three
        // stacked radios, no inherited margin, and symmetric padding so the list is evenly spaced.
        style: {
          backgroundColor: 'transparent',
          cursor: 'default',
          height: 'auto',
          lineHeight: 'normal',
          margin: 0,
          padding: '4px 8px',
        },
        label: (
          // Centre the radio block; the group sizes to its widest option so every row stretches to
          // the same width and the dots line up in a column. The wrapper swallows the click so picking
          // a radio doesn't bubble to the antd menu item and close the menu (Radio.Group has no onClick).
          <div style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
            <Radio.Group
              style={{ display: 'flex', flexDirection: 'column' }}
              value={thermometer.measuringAreaType ?? MeasuringAreaType.Point}
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
          </div>
        ),
      },
    ],
  };
};
