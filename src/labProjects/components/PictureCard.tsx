/*
 * A picture the AI made, as Discuss shows it with a reply: the picture at
 * its own proportions over its caption, in a card a click opens full size.
 */

import styled from 'styled-components';
import type { ProjectImage } from '../core/types';
import { pictureCaption } from '../format';

const Card = styled.button`
  display: block;
  width: 100%;
  max-width: 560px;
  margin-top: 8px;
  padding: 0;
  border: 1px solid var(--ifi-stroke-1);
  border-radius: 10px;
  overflow: hidden;
  background: var(--ifi-panel);
  text-align: left;
  cursor: zoom-in;
  font: inherit;
  color: inherit;

  img {
    display: block;
    width: 100%;
    max-height: 360px;
    object-fit: contain;
    background: var(--ifi-fill-1);
  }
  .pc-caption {
    display: block;
    padding: 7px 10px;
    font-size: 13px;
    color: var(--ifi-text-secondary);
  }
  &:hover {
    border-color: var(--ifi-stroke-2);
  }
  &:focus-visible {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }
`;

const PictureCard = ({ image, onOpen }: { image: ProjectImage; onOpen: (img: ProjectImage) => void }) => {
  const caption = pictureCaption(image);
  return (
    <Card type="button" onClick={() => onOpen(image)} aria-label={image.caption || 'Picture'}>
      <img src={image.url} alt={image.caption} loading="lazy" />
      {caption && <span className="pc-caption">{caption}</span>}
    </Card>
  );
};

export default PictureCard;
