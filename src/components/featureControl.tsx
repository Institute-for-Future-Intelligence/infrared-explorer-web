import { Tooltip, message } from 'antd';
import type { MenuProps } from 'antd';
import { StarOutlined, StarFilled } from '@ant-design/icons';
import { Visibility } from '../types';
import { setFeatured } from '../services/experiments';
import { isStaff } from '../utils/staff';
import useCommonStore from '../stores/common';

/*
 * "Feature on the homepage" — a staff-only control over an experiment's `featured` flag (the
 * site homepage lists `featured == true && visibility == 'public'`). Staff (@intofuture.org) may
 * feature their OWN experiments from the UI instead of running scripts/feature.mjs; the Firestore
 * rules enforce staff-and-owner and the "featured ⇒ public" invariant. Featuring a non-public
 * experiment promotes it to Public first (setFeatured does this and mirrors the sub-docs); the
 * reverse also holds — demoting a featured experiment below Public un-features it (see
 * changeVisibility in visibilityControl).
 */

/**
 * Toggle an experiment's featured state with toast feedback. Staff-only (the control is only
 * offered to staff, but re-check here for the expired-session edge). Resolves the experiment's
 * resulting visibility (Public if featuring promoted it) so the caller can sync its state, or
 * null on failure / not-permitted.
 */
export async function changeFeatured(
  expId: string,
  featured: boolean,
  currentVisibility: Visibility | undefined,
): Promise<{ visibility: Visibility | undefined } | null> {
  const user = useCommonStore.getState().user;
  if (!user || !isStaff(user)) {
    message.error('Only staff can feature experiments on the homepage');
    return null;
  }
  try {
    const { promotedToPublic } = await setFeatured(expId, user, featured, currentVisibility);
    const visibility = promotedToPublic ? Visibility.Public : currentVisibility;
    message.success(
      featured
        ? promotedToPublic
          ? 'Added to the homepage showcase (set to Public)'
          : 'Added to the homepage showcase'
        : 'Removed from the homepage showcase',
    );
    return { visibility };
  } catch (e) {
    console.error('failed to change featured', e);
    message.error('Failed to update homepage feature');
    return null;
  }
}

/**
 * Small badge marking a card as in the homepage showcase — shown on owner grids so the "Add to
 * homepage showcase" action has a visible, persistent effect (the ⋮ menu only reflects it when
 * reopened). Static (not absolutely positioned): the card lays it out in the top-right flex row
 * next to the options button. `pointer-events: none` so a click falls through to open the card.
 * Never shown on public grids (the homepage is already all-featured, so it would be noise there).
 */
export const FeaturedBadge = () => (
  <Tooltip title="This experiment is in the homepage showcase.">
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 8,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        cursor: 'default',
      }}
    >
      <StarFilled style={{ color: 'var(--ifi-heat)', fontSize: 13 }} />
    </span>
  </Tooltip>
);

/**
 * Homepage-feature item for an owned card's ⋮ dropdown, for STAFF only (the caller gates on
 * isStaff before including it). Featuring a non-public experiment will also set it Public.
 */
export function buildFeatureMenuItem(
  featured: boolean,
  onToggle: (next: boolean) => void,
): NonNullable<MenuProps['items']>[number] {
  return {
    key: 'feature',
    icon: featured ? <StarFilled style={{ color: 'var(--ifi-heat)' }} /> : <StarOutlined />,
    label: featured ? 'Remove from homepage showcase' : 'Add to homepage showcase',
    onClick: () => onToggle(!featured),
  };
}
