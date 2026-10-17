/*
 * How a project is shared, as an icon badge in a card's top-left corner
 * (owner grids only): the Share panel's Lock, Link or Globe, red with a
 * ban once staff took it down — the look of an experiment card's
 * visibility badge (components/visibilityControl VisibilityBadge), so My
 * Experiments reads like My Recordings. The tier is named in the tooltip;
 * with `onClick` the badge opens the Share panel, as the project page's
 * ShareChip does.
 */

import type { KeyboardEvent, MouseEvent } from 'react';
import { Tooltip } from 'antd';
import { Ban } from 'lucide-react';
import styled from 'styled-components';
import type { ShareVisibility } from '../core/types';
import { SHARE_TIERS, TAKEN_DOWN } from '../shareTiers';

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: #fff;
  font: inherit;
  /* the card corners leave pointer events off; the tooltip needs them */
  pointer-events: auto;

  &.down {
    background: var(--ifi-danger);
  }
  &:is(button) {
    cursor: pointer;
  }
  &:is(button):hover {
    filter: brightness(1.25);
  }
  &:is(button):focus-visible {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }
  svg {
    flex: none;
  }
`;

const ShareBadge = ({
  visibility,
  takenDown,
  onClick,
}: {
  visibility: ShareVisibility | undefined;
  takenDown?: boolean;
  onClick?: () => void;
}) => {
  const tier = SHARE_TIERS.find((t) => t.key === (visibility ?? 'private')) ?? SHARE_TIERS[0];
  // as ShareChip: a private project carries no share, so it is never shown as taken down
  const down = !!takenDown && tier.key !== 'private';
  const Icon = down ? Ban : tier.icon;
  const label = down ? 'Taken down' : tier.label;
  const hint = down ? `${TAKEN_DOWN} Only you can open it.` : tier.hint;
  return (
    <Tooltip
      title={
        <>
          <strong>{label}</strong> · {hint}
        </>
      }
    >
      {onClick ? (
        <Badge
          as="button"
          type="button"
          className={down ? 'down' : undefined}
          aria-label={`Sharing: ${label}`}
          // the badge sits on a card that opens on click and Enter
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            onClick();
          }}
          onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
        >
          <Icon size={14} strokeWidth={2} aria-hidden />
        </Badge>
      ) : (
        <Badge className={down ? 'down' : undefined} role="img" aria-label={`Sharing: ${label}`}>
          <Icon size={14} strokeWidth={2} aria-hidden />
        </Badge>
      )}
    </Tooltip>
  );
};

export default ShareBadge;
