import { useNavigate } from 'react-router-dom';
import type { MenuProps } from 'antd';
import Card, { CardMeta } from './card';
import CardListWrapper from './cardListWrapper';
import { Visibility } from '../../types';
import { authorProfilePath } from '../../utils/helpers';

export interface GridItem extends CardMeta {
  id: string;
  thumbnailURL: string;
  displayName: string;
  // Optional identity/visibility ride-alongs: ownerId turns the hover-overlay author line into a
  // profile link; visibility feeds the owner card menu's Visibility submenu; featured feeds the
  // staff "Feature on homepage" item. Absent on grids whose source rows don't carry them (e.g. the
  // denormalized Recent-page history snapshots).
  ownerId?: string;
  visibility?: Visibility;
  featured?: boolean;
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
  // Show each card's visibility tier as an icon badge (owner grids where tiers are mixed); off by default.
  showVisibility?: boolean;
  // When set, each card's visibility badge becomes a click-to-change dropdown (owner grids).
  onVisibilityChange?: (id: string, v: Visibility) => void;
}

/** Shared grid of experiment cards: click a card to open it; optional per-card delete / menu. */
const ExperimentGrid = ({
  items,
  onDelete,
  buildMenu,
  showUpdated,
  showAuthor = true,
  showVisibility,
  onVisibilityChange,
}: Props) => {
  const navigate = useNavigate();

  return (
    <CardListWrapper>
      {items.map((item) => {
        const authorHref = showAuthor ? authorProfilePath(item.ownerId, item.author) : undefined;
        return (
          <Card
            key={item.id}
            id={item.id}
            url={item.thumbnailURL}
            displayName={item.displayName}
            subject={item.subject}
            visibility={item.visibility}
            showVisibility={showVisibility}
            featured={item.featured}
            onVisibilityChange={onVisibilityChange ? (v) => onVisibilityChange(item.id, v) : undefined}
            author={showAuthor ? item.author : undefined}
            description={item.description}
            ratingSum={item.ratingSum}
            ratingCount={item.ratingCount}
            viewCount={item.viewCount}
            commentCount={item.commentCount}
            createdAt={item.createdAt}
            updatedAt={showUpdated ? item.updatedAt : undefined}
            duration={item.duration}
            sourceType={item.sourceType}
            photoCount={item.photoCount}
            onOpen={(id) => navigate(`/experiments/${id}`)}
            onAuthorClick={authorHref ? () => navigate(authorHref) : undefined}
            onDelete={onDelete}
            menuItems={buildMenu?.(item)}
          />
        );
      })}
    </CardListWrapper>
  );
};

export default ExperimentGrid;
