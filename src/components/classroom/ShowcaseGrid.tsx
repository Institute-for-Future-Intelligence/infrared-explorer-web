import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Tag } from 'antd';
import { PushpinOutlined, DeleteOutlined } from '@ant-design/icons';
import Card from '../card/card';
import CardListWrapper from '../card/cardListWrapper';
import { ShowcaseItem } from '../../classroom/types';
import { removeShowcaseItem, setShowcasePinned, subscribeShowcase } from '../../classroom/classroomApi';

interface Props {
  classId: string;
  isTeacher: boolean;
}

/**
 * Class-wide showcase of teacher-curated student work (promoted from assignments).
 * Teaching materials live in MaterialsSection; this tab is the "精选作品" wall.
 */
const ShowcaseGrid = ({ classId, isTeacher }: Props) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<ShowcaseItem[]>([]);

  useEffect(
    () => subscribeShowcase(classId, (all) => setItems(all.filter((i) => i.kind === 'student-work'))),
    [classId],
  );

  if (items.length === 0)
    return (
      <Empty description={isTeacher ? '在作业里“精选到展示墙”，把优秀作品展示给全班。' : '老师还没有精选展示作品。'} />
    );

  return (
    <CardListWrapper>
      {items.map((item) => (
        <div key={item.id} style={{ position: 'relative' }}>
          {item.pinned && (
            <Tag color="gold" style={{ position: 'absolute', top: 4, left: 4, zIndex: 1, margin: 0 }}>
              置顶
            </Tag>
          )}
          <Card
            id={item.expId}
            url={item.thumbnailURL}
            displayName={item.title}
            author={item.ownerName}
            createdAt={item.createdAt ?? null}
            onOpen={(id) => navigate(`/experiments/${id}`)}
            menuItems={
              isTeacher
                ? [
                    {
                      key: 'pin',
                      label: item.pinned ? '取消置顶' : '置顶',
                      icon: <PushpinOutlined />,
                      onClick: () => setShowcasePinned(classId, item.id, !item.pinned),
                    },
                    {
                      key: 'remove',
                      label: '移除',
                      icon: <DeleteOutlined />,
                      danger: true,
                      onClick: () => removeShowcaseItem(classId, item.id),
                    },
                  ]
                : undefined
            }
          />
        </div>
      ))}
    </CardListWrapper>
  );
};

export default ShowcaseGrid;
