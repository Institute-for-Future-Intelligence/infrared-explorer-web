import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { MenuOutlined } from '@ant-design/icons';

interface Props {
  onSavePNG: () => void;
  onExportCSV: () => void;
}

/**
 * Per-chart hamburger menu (Save as image / Export CSV), pinned top-right. Marked
 * `data-html2canvas-ignore` so the button itself is excluded from the chart's PNG export.
 */
const ChartMenu = ({ onSavePNG, onExportCSV }: Props) => {
  const items: MenuProps['items'] = [
    { key: 'png', label: 'Save as image', onClick: onSavePNG },
    { key: 'csv', label: 'Export CSV', onClick: onExportCSV },
  ];

  return (
    <div data-html2canvas-ignore style={{ position: 'absolute', right: 4, top: 4, zIndex: 1 }}>
      <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
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
