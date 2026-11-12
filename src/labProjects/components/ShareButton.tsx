/*
 * How the project is shared, as the button left of the ⋮ in the title row
 * (owner only): Private, Link Only or Public beside the Share panel's icon,
 * teal while someone else can open it, red once staff took it down (it then
 * opens for nobody but the owner, whatever the tier). A click opens the
 * Share panel, as the ⋮ menu's Share… does. The site's one such button
 * (components/shareMenu ShareStateButton), which a recording's owner has in
 * the analyzer's title row, in a project's words; it was a chip in the
 * title's facts until 2026-11-12.
 */

import { Ban } from 'lucide-react';
import { ShareStateButton } from '../../components/shareMenu';
import type { ShareInfo } from '../core/types';
import { SHARE_TIERS, TAKEN_DOWN } from '../shareTiers';

/** The glyph as the analyzer's button draws it. */
const ICON = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const;

const ShareButton = ({
  share,
  compact,
  onClick,
}: {
  share: ShareInfo | null | undefined;
  /** The glyph alone, the tier's name in the tooltip (a title row short of room). */
  compact?: boolean;
  /** Opens the Share panel; without it the button is off and only says the state. */
  onClick?: () => void;
}) => {
  const visibility = share?.visibility ?? 'private';
  const tier = SHARE_TIERS.find((t) => t.key === visibility) ?? SHARE_TIERS[0];
  const down = share != null && share.takenDown;
  const Icon = down ? Ban : tier.icon;
  return (
    <ShareStateButton
      state={{
        icon: <Icon {...ICON} />,
        label: down ? 'Taken down' : tier.label,
        hint: down ? `${TAKEN_DOWN} Only you can open it.` : tier.hint,
        open: share != null && !down,
        down,
      }}
      compact={compact}
      onClick={onClick}
    />
  );
};

export default ShareButton;
