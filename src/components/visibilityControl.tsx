import { message } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { Ban, Globe, Link2, Lock } from 'lucide-react';
import { Tooltip } from 'antd';
import styled from 'styled-components';
import { Visibility } from '../types';
import { updateVisibility } from '../services/experiments';
import useCommonStore from '../stores/common';

/*
 * The one place that names the three visibility tiers for the UI — for a recording (an
 * `experiments` doc), an AI experiment (a lab project) and a street view alike; the app's
 * src/lib/visibility.ts says the same. The stored Firestore value for the middle tier stays
 * 'unlisted' (no data migration); the UI calls it "Link Only".
 *   Private   — only the owner can open it
 *   Link Only — anyone with the link can open it; on no list (profile / Community / search)
 *   Public    — listed where the kind gets listed; anyone can find and open it
 * (The site homepage is curated separately via the staff-only `featured` flag.)
 *
 * The wording model (user's call 2026-10-19): "Share" is the entrance — the act of letting
 * others open something, by link or by listing it — and the tiers answer "who can open it"
 * inside that panel (components/shareDialog). "Visibility" names the same property where it
 * is read or set in bulk: a filter, a sort, a selection bar. Private, inside a Share panel,
 * is how sharing is taken back.
 */

/** What is being shared; the Public hint names where it gets listed. */
export type ShareKind = 'recording' | 'experiment' | 'streetView';

const PUBLIC_WHERE: Record<ShareKind, string> = {
  recording: 'Listed in Community and on your profile. Anyone can find it.',
  experiment: 'Listed in Community. Anyone can find it.',
  streetView: 'On the Street View map. Anyone can find it and see where it was shot.',
};

/** The one-line hint under a tier's name in a Share panel. */
export const tierHint = (kind: ShareKind, v: Visibility): string => {
  switch (v) {
    case Visibility.Private:
      return 'Only you can open it. Links stop working for others.';
    case Visibility.Unlisted:
      return 'Anyone with the link can open it. Nobody else can find it.';
    case Visibility.Public:
      return PUBLIC_WHERE[kind];
    default:
      return '';
  }
};

export const VISIBILITY_OPTIONS: { value: Visibility; label: string; icon: typeof Lock }[] = [
  { value: Visibility.Private, label: 'Private', icon: Lock },
  { value: Visibility.Unlisted, label: 'Link Only', icon: Link2 },
  { value: Visibility.Public, label: 'Public', icon: Globe },
];

export const visibilityLabel = (v: Visibility): string => VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? v;

/** The tier's glyph at the size a menu row or a chip wants. */
export const VisibilityIcon = ({ visibility, size = 14 }: { visibility: Visibility; size?: number }) => {
  const Icon = VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.icon ?? Lock;
  return <Icon size={size} strokeWidth={2} aria-hidden />;
};

/** What staff did to a project: not listed, and nobody but the owner opens it. */
export const TAKEN_DOWN = 'Staff removed this experiment from Community.';

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

/**
 * Icon-only badge naming a card's visibility tier (Lock / Link / Globe), for owner grids where
 * private / link-only / public items are mixed together — red with a ban once staff took a
 * project down. The tier is named in the tooltip; with `onClick` the badge opens the Share panel.
 * Never shown on public-facing grids (home / a visitor's profile), where everything is public and
 * it'd be noise.
 */
export const VisibilityBadge = ({
  visibility,
  kind = 'recording',
  takenDown,
  onClick,
}: {
  visibility: Visibility | undefined;
  kind?: ShareKind;
  takenDown?: boolean;
  onClick?: () => void;
}) => {
  const v = visibility ?? Visibility.Private;
  // a private project carries no share, so it is never shown as taken down
  const down = !!takenDown && v !== Visibility.Private;
  const Icon = down ? Ban : (VISIBILITY_OPTIONS.find((o) => o.value === v)?.icon ?? Lock);
  const label = down ? 'Taken down' : visibilityLabel(v);
  const hint = down ? `${TAKEN_DOWN} Only you can open it.` : tierHint(kind, v);
  const aria = `Visibility: ${label}`;
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
          aria-label={aria}
          // the badge sits on a card that opens on click and Enter
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onClick();
          }}
          onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
        >
          <Icon size={14} strokeWidth={2} aria-hidden />
        </Badge>
      ) : (
        <Badge className={down ? 'down' : undefined} role="img" aria-label={aria}>
          <Icon size={14} strokeWidth={2} aria-hidden />
        </Badge>
      )}
    </Tooltip>
  );
};

/** The toast after a change: the consequence, not just the new value. */
export const changedToast = (kind: ShareKind, v: Visibility): string => {
  switch (v) {
    case Visibility.Private:
      return 'Set to Private. Existing links stop working for others.';
    case Visibility.Unlisted:
      return 'Set to Link Only. Only people with the link can open it.';
    case Visibility.Public:
      return `Set to Public. ${PUBLIC_WHERE[kind]}`;
    default:
      return '';
  }
};

/**
 * What a tier will mean for `n` items of a kind, for a bulk change's confirm dialog — the tier
 * hints, in the number of the items about to change.
 */
export const consequence = (kind: ShareKind, v: Visibility, n: number): string => {
  const one = n === 1;
  const it = one ? 'it' : 'them';
  switch (v) {
    case Visibility.Private:
      return `Only you will be able to open ${it}. Existing links stop working for others.`;
    case Visibility.Unlisted:
      return `Anyone with the link can open ${it}. Nobody else can find ${it}.`;
    case Visibility.Public: {
      // "Listed in Community. Anyone can find it." → "They will be listed in Community. Anyone can find them."
      const [listed, find] = PUBLIC_WHERE[kind].split('. ');
      return `${one ? 'It' : 'They'} will be ${listed.charAt(0).toLowerCase()}${listed.slice(1)}. ${find.replace(/\bit\b/, it)}`;
    }
    default:
      return '';
  }
};

export const UNFEATURED_TOAST = 'Removed from the homepage showcase. Only public recordings are featured.';

/**
 * Change a recording's visibility with toast feedback; resolves null on failure. Demoting a
 * featured recording below Public also clears its homepage `featured` flag in the same write
 * (pass `currentFeatured` so this is detectable): the homepage only lists public clips, so a
 * lingering flag would keep the Homepage toggle lit — and break the rules' "featured ⇒ public"
 * invariant — while the recording is invisible there. `unfeatured` reports that side effect so
 * callers can sync their copy of the flag.
 */
export async function changeVisibility(
  expId: string,
  visibility: Visibility,
  currentFeatured?: boolean,
): Promise<{ unfeatured: boolean } | null> {
  const user = useCommonStore.getState().user;
  if (!user) {
    // The control only renders on owned experiments, so this is a signed-out edge (expired session).
    message.error('Sign in to change visibility');
    return null;
  }
  const unfeature = !!currentFeatured && visibility !== Visibility.Public;
  try {
    await updateVisibility(expId, user, visibility, { unfeature });
    message.success(changedToast('recording', visibility));
    if (unfeature) message.info(UNFEATURED_TOAST);
    return { unfeatured: unfeature };
  } catch (e) {
    console.error('failed to change visibility', e);
    message.error('Failed to change visibility');
    return null;
  }
}

/**
 * The three visibility-tier menu rows (current tier checkmarked; picking another calls onSelect) —
 * for the multi-select bar's Visibility dropdown, where `current` is the tier the whole selection
 * shares, or undefined when mixed. A single item's tier is changed in its Share panel instead.
 */
export function visibilityMenuItems(
  current: Visibility | undefined,
  onSelect: (v: Visibility) => void,
): MenuProps['items'] {
  return VISIBILITY_OPTIONS.map((o) => ({
    key: `visibility-${o.value}`,
    icon: <o.icon size={14} strokeWidth={2} aria-hidden />,
    label: (
      <span title={tierHint('recording', o.value)}>
        {o.label}
        {o.value === current && <CheckOutlined style={{ marginLeft: 8, fontSize: 11 }} />}
      </span>
    ),
    onClick: () => {
      if (o.value !== current) onSelect(o.value);
    },
  }));
}
