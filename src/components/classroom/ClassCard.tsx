import { Card, Tag, Typography } from 'antd';
import { TeamOutlined } from '@ant-design/icons';
import { ClassInfo } from '../../classroom/types';

/**
 * Compact class tile (name + role tag + member count), shared by the My Classes page grid and the
 * Me hub's classes strip. `cardWidth` lets each surface pick its own sizing (responsive width on
 * the page, fixed flex-basis in the strip).
 */
const ClassCard = ({
  info,
  taught,
  onOpen,
  cardWidth,
}: {
  info: ClassInfo;
  taught: boolean;
  onOpen: () => void;
  cardWidth: number | string;
}) => (
  <Card hoverable onClick={onOpen} style={{ width: cardWidth }} styles={{ body: { padding: 16 } }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Typography.Text strong ellipsis style={{ fontSize: 16 }}>
        {info.name}
      </Typography.Text>
      {taught ? <Tag color="blue">Teacher</Tag> : <Tag>Student</Tag>}
    </div>
    <div style={{ marginTop: 8, color: '#888', fontSize: 13 }}>
      <TeamOutlined /> {info.memberCount ?? 0}
      {taught && <span style={{ marginLeft: 12 }}>number {info.classNumber}</span>}
    </div>
  </Card>
);

export default ClassCard;
