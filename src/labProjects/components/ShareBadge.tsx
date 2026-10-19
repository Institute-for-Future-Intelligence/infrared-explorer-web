/*
 * How a project is shared, as an icon badge in a card's top-left corner
 * (owner grids only) — the site's one visibility badge
 * (components/visibilityControl VisibilityBadge) in a project's words, so
 * My Experiments reads like My Recordings. With `onClick` the badge opens
 * the Share panel, as the project page's ShareChip does.
 */

import { Visibility } from '../../types';
import { VisibilityBadge } from '../../components/visibilityControl';
import type { ShareVisibility } from '../core/types';

const ShareBadge = ({
  visibility,
  takenDown,
  onClick,
}: {
  visibility: ShareVisibility | undefined;
  takenDown?: boolean;
  onClick?: () => void;
}) => (
  <VisibilityBadge
    visibility={(visibility ?? 'private') as Visibility}
    kind="experiment"
    takenDown={takenDown}
    onClick={onClick}
  />
);

export default ShareBadge;
