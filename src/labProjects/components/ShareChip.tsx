/*
 * How the project is shared, as a chip in the title's facts (owner
 * only): Private, Link Only or Public with the Share panel's
 * icon, teal while someone else can open it, red once staff took it down
 * (it then opens for nobody but the owner, whatever the tier). A click
 * opens the Share panel, as the ⋯ menu's Share… does.
 */

import { Tooltip } from 'antd';
import { Ban } from 'lucide-react';
import styled from 'styled-components';
import type { ShareInfo } from '../core/types';
import { SHARE_TIERS, TAKEN_DOWN } from '../shareTiers';

/** The size of an antd Tag. */
const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid var(--ifi-stroke-1);
  border-radius: 4px;
  background: var(--ifi-fill-1);
  color: var(--ifi-text-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;

  &.shared {
    border-color: var(--ifi-teal);
    background: var(--ifi-teal-film);
    color: var(--ifi-teal-dark);
  }
  &.down {
    border-color: var(--ifi-danger);
    background: var(--ifi-danger-fill);
    color: var(--ifi-danger);
  }
  &:disabled {
    cursor: default;
  }
  &:hover:not(:disabled) {
    filter: brightness(0.96);
  }
  svg {
    flex: none;
  }
`;

const ShareChip = ({ share, onClick }: { share: ShareInfo | null | undefined; onClick?: () => void }) => {
  const visibility = share?.visibility ?? 'private';
  const tier = SHARE_TIERS.find((t) => t.key === visibility) ?? SHARE_TIERS[0];
  const down = share != null && share.takenDown;
  const Icon = down ? Ban : tier.icon;
  const hint = down ? `${TAKEN_DOWN} Only you can open it.` : tier.hint;
  return (
    <Tooltip title={hint}>
      <Chip
        type="button"
        className={down ? 'down' : share != null ? 'shared' : undefined}
        onClick={onClick}
        disabled={!onClick}
        aria-label={`Visibility: ${down ? 'taken down' : tier.label}`}
      >
        <Icon size={12} strokeWidth={2} aria-hidden />
        {down ? 'Taken down' : tier.label}
      </Chip>
    </Tooltip>
  );
};

export default ShareChip;
