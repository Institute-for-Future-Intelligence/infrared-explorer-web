import { useState } from 'react';
import { Select, message } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined, GlobalOutlined, LinkOutlined, LockOutlined } from '@ant-design/icons';
import { Visibility } from '../types';
import { updateVisibility } from '../services/experiments';
import useCommonStore from '../stores/common';

/*
 * The one place that names the three visibility tiers for the UI. The stored Firestore value
 * for the middle tier stays 'unlisted' (no data migration); the UI calls it "Link only".
 *   Private   — only the owner can open it
 *   Link only — anyone with the link can open it; on no list (profile / homepage / search)
 *   Public    — shown on the owner's profile page; anyone can find and open it
 * (The site homepage is curated separately via the staff-only `featured` flag.)
 */

export const VISIBILITY_OPTIONS: { value: Visibility; label: string; hint: string; icon: JSX.Element }[] = [
  { value: Visibility.Private, label: 'Private', hint: 'Only you can open it', icon: <LockOutlined /> },
  {
    value: Visibility.Unlisted,
    label: 'Link only',
    hint: 'Anyone with the link can open it',
    icon: <LinkOutlined />,
  },
  {
    value: Visibility.Public,
    label: 'Public',
    hint: 'Shown on your profile — anyone can find it',
    icon: <GlobalOutlined />,
  },
];

export const visibilityLabel = (v: Visibility): string => VISIBILITY_OPTIONS.find((o) => o.value === v)?.label ?? v;

// Toast copy states the consequence, not just the new value.
const CHANGED_TOAST: Record<Visibility, string> = {
  [Visibility.Public]: 'Set to Public — now shown on your profile',
  [Visibility.Unlisted]: 'Set to Link only — only people with the link can open it',
  [Visibility.Private]: 'Set to Private — existing links stop working for others',
};

/** Change an experiment's visibility with toast feedback; resolves true on success. */
export async function changeVisibility(expId: string, visibility: Visibility): Promise<boolean> {
  const user = useCommonStore.getState().user;
  if (!user) {
    // The control only renders on owned experiments, so this is a signed-out edge (expired session).
    message.error('Sign in to change visibility');
    return false;
  }
  try {
    await updateVisibility(expId, user, visibility);
    message.success(CHANGED_TOAST[visibility]);
    return true;
  } catch (e) {
    console.error('failed to change visibility', e);
    message.error('Failed to change visibility');
    return false;
  }
}

/**
 * "Visibility" submenu for an owned card's ⋮ dropdown (My Experiments / the owner's profile
 * tabs). The current tier is checkmarked; picking another tier calls onSelect with it.
 */
export function buildVisibilityMenuItem(
  current: Visibility,
  onSelect: (v: Visibility) => void,
): NonNullable<MenuProps['items']>[number] {
  return {
    key: 'visibility',
    label: 'Visibility',
    icon: VISIBILITY_OPTIONS.find((o) => o.value === current)?.icon,
    children: VISIBILITY_OPTIONS.map((o) => ({
      key: `visibility-${o.value}`,
      icon: o.icon,
      label: (
        <span title={o.hint}>
          {o.label}
          {o.value === current && <CheckOutlined style={{ marginLeft: 8, fontSize: 11 }} />}
        </span>
      ),
      onClick: () => {
        if (o.value !== current) onSelect(o.value);
      },
    })),
  };
}

/**
 * Inline visibility picker for the analyzer's info section (owner-only). Persists the change
 * itself (with toasts) and reports the new value up so the caller can sync its state.
 */
export const VisibilitySelect = ({
  expId,
  value,
  onChanged,
}: {
  expId: string;
  value: Visibility;
  onChanged?: (v: Visibility) => void;
}) => {
  const [saving, setSaving] = useState(false);

  const onChange = async (v: Visibility) => {
    if (v === value) return;
    setSaving(true);
    try {
      if (await changeVisibility(expId, v)) onChanged?.(v);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Select
      size="small"
      value={value}
      loading={saving}
      disabled={saving}
      onChange={onChange}
      popupMatchSelectWidth={false}
      aria-label="Visibility"
      style={{ minWidth: 132 }}
      options={VISIBILITY_OPTIONS.map((o) => ({
        value: o.value,
        title: o.hint,
        label: (
          <span>
            {o.icon} {o.label}
          </span>
        ),
      }))}
    />
  );
};
