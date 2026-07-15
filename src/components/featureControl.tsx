import { useState } from 'react';
import { Switch, Tooltip, message } from 'antd';
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
 * experiment promotes it to Public first (setFeatured does this and mirrors the sub-docs).
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
  <Tooltip title="This experiment is showcased on the app's homepage.">
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
      <StarFilled style={{ color: '#fadb14', fontSize: 13 }} />
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
    icon: featured ? <StarFilled style={{ color: '#fadb14' }} /> : <StarOutlined />,
    label: featured ? 'Remove from homepage showcase' : 'Add to homepage showcase',
    onClick: () => onToggle(!featured),
  };
}

/**
 * Inline homepage-feature switch for the analyzer's info section. Renders nothing unless the
 * viewer is staff AND owns the experiment. Persists the change (with toasts) and reports the new
 * featured state — and any visibility promotion — up so the caller can sync its experiment state.
 */
export const FeatureToggle = ({
  expId,
  ownerId,
  featured,
  visibility,
  onChanged,
}: {
  expId: string;
  ownerId: string | undefined;
  featured: boolean;
  visibility: Visibility | undefined;
  onChanged?: (next: { featured: boolean; visibility: Visibility | undefined }) => void;
}) => {
  const user = useCommonStore((state) => state.user);
  const [saving, setSaving] = useState(false);

  // Staff-only, and only on their own experiments (mirrors the rules; 'system' has no signed-in owner).
  if (!user || !isStaff(user) || ownerId !== user.id) return null;

  const onToggle = async (next: boolean) => {
    setSaving(true);
    try {
      const res = await changeFeatured(expId, next, visibility);
      if (res) onChanged?.({ featured: next, visibility: res.visibility });
    } finally {
      setSaving(false);
    }
  };

  // No inline "Homepage" text: this always sits inside a labeled <dt>Homepage</dt> row, so the
  // switch + star (mirroring how the Visibility row shows only its value) reads cleanly.
  return (
    <Tooltip title="Show this experiment on the site homepage. Staff-only; featuring also makes it Public.">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <Switch size="small" checked={featured} loading={saving} onChange={onToggle} aria-label="Feature on homepage" />
        {featured ? <StarFilled style={{ color: '#fadb14' }} /> : <StarOutlined />}
      </span>
    </Tooltip>
  );
};
