import { ReactNode } from 'react';

interface Props {
  // Optional: cards self-handle clicks via onOpen; kept for the legacy delegation callers.
  onClick?: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => void;
  children: ReactNode;
}

const CardListWrapper = ({ onClick, children }: Props) => {
  return (
    <div className="card-list-wrapper">
      <div className="card-list" onClick={onClick}>
        {children}
      </div>
    </div>
  );
};

export default CardListWrapper;
