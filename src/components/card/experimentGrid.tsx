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
  // Surface each card's last-updated date in its hover overlay (My Experiments); off by default.
  showUpdated?: boolean;
  // Show the author line in the hover overlay; on by default. Owners' own grids hide it (redundant).
  showAuthor?: boolean;
}

/** Shared grid of experiment cards: click a card to open it; optional per-card delete / menu. */
const ExperimentGrid = ({ items, onDelete, buildMenu, showUpdated, showAuthor = true }: Props) => {
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
          author={showAuthor ? item.author : undefined}
          description={item.description}
          ratingSum={item.ratingSum}
          ratingCount={item.ratingCount}
          viewCount={item.viewCount}
          commentCount={item.commentCount}
          createdAt={item.createdAt}
          updatedAt={showUpdated ? item.updatedAt : undefined}
          duration={item.duration}
          onOpen={(id) => navigate(`/experiments/${id}`)}
          onDelete={onDelete}
          menuItems={buildMenu?.(item)}
        />
      ))}
    </CardListWrapper>
  );
};

export default ExperimentGrid;
