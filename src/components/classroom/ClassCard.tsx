import type { ReactNode } from 'react';
import { Card, Typography } from 'antd';
import { TeamOutlined } from '@ant-design/icons';
import { ClassInfo } from '../../classroom/types';

/**
 * Compact class tile (name, member count, the class number), shared by the My Classes page grid
 * and the Me hub's classes strip. Every class shown is one the user teaches (the minimal classroom,
 * 2026-11-02), so there is no role tag and no "you teach". `cardWidth` lets each surface pick its
 * own sizing (responsive width on the page, fixed flex-basis in the strip); `menu` is the ⋮ the
 * list puts in the corner (ClassActionsMenu).
 */
const ClassCard = ({
  info,
  onOpen,
  cardWidth,
  menu,
}: {
  info: ClassInfo;
  onOpen: () => void;
  cardWidth: number | string;
  menu?: ReactNode;
}) => (
  <Card hoverable onClick={onOpen} style={{ width: cardWidth }} styles={{ body: { padding: 16 } }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <Typography.Text strong ellipsis style={{ fontSize: 16 }}>
        {info.name || 'Unnamed class'}
      </Typography.Text>
      {menu}
    </div>
    <div style={{ marginTop: 8, color: '#888', fontSize: 13 }}>
      <TeamOutlined /> {info.memberCount ?? 0}
      <span style={{ marginLeft: 12 }}>#{info.classNumber}</span>
    </div>
  </Card>
);

export default ClassCard;
