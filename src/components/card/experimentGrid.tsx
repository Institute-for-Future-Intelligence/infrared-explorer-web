import { useNavigate } from 'react-router-dom';
import type { MenuProps } from 'antd';
import Card, { CardMeta } from './card';
import CardListWrapper from './cardListWrapper';

export interface GridItem extends CardMeta {
  id: string;
  thumbnailURL: string;
  displayName: string;
}

interface Props {
  items: GridItem[];
  onDelete?: (id: string) => void;
  // Build a per-card dropdown menu (rename / open in new tab / move to trash). Takes precedence over onDelete.
  buildMenu?: (item: GridItem) => MenuProps['items'];
}

/** Shared grid of experiment cards: click a card to open it; optional per-card delete / menu. */
const ExperimentGrid = ({ items, onDelete, buildMenu }: Props) => {
  const navigate = useNavigate();

  return (
    <CardListWrapper>
      {items.map((item) => (
        <Card
          key={item.id}
          id={item.id}
          url={item.thumbnailURL}
          displayName={item.displayName}
          subject={item.subject}
          author={item.author}
          description={item.description}
          ratingSum={item.ratingSum}
          ratingCount={item.ratingCount}
          viewCount={item.viewCount}
          commentCount={item.commentCount}
          onOpen={(id) => navigate(`/experiments/${id}`)}
          onDelete={onDelete}
          menuItems={buildMenu?.(item)}
        />
      ))}
    </CardListWrapper>
  );
};

export default ExperimentGrid;
