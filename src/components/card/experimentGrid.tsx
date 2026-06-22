import { useNavigate } from 'react-router-dom';
import Card from './card';
import CardListWrapper from './cardListWrapper';

export interface GridItem {
  id: string;
  thumbnailURL: string;
  displayName: string;
}

interface Props {
  items: GridItem[];
  onDelete?: (id: string) => void;
}

/** Shared grid of experiment cards: click a card to open it; optional per-card delete. */
const ExperimentGrid = ({ items, onDelete }: Props) => {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    const expId = (e.target as any).id;
    if (expId) {
      navigate(`/experiments/${expId}`);
    }
  };

  return (
    <CardListWrapper onClick={handleClick}>
      {items.map((item) => (
        <Card key={item.id} id={item.id} url={item.thumbnailURL} displayName={item.displayName} onDelete={onDelete} />
      ))}
    </CardListWrapper>
  );
};

export default ExperimentGrid;
