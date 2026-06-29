import { useEffect, useState } from 'react';
import { Avatar, Button, Form, Input, Switch, message } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import useCommonStore from '../stores/common';
import { getUserProfile, getUserStats, updateUserProfile, UserPrefs, UserStats } from '../services/account';
import { useIsMobile } from '../hooks/useIsMobile';

/*
 * Account settings — ported from Telelab for parity: a profile sidebar (avatar, name,
 * Telelab ID, clip/comment counts) beside a tabbed pane. "General" edits the display
 * nickname; "Permissions" holds the privacy/notification toggles; Terms of Service and
 * Privacy Policy are external links. Telelab's "Rooms" section is omitted — it belonged
 * to the live-streaming feature dropped in this migration (docs/telelab-migration.md).
 */

const TERMS_URL = 'https://intofuture.org/telelab-terms.html';
const PRIVACY_URL = 'https://intofuture.org/telelab-privacy.html';

type Tab = 'general' | 'permissions';

const PERMISSIONS: { key: keyof UserPrefs; label: string }[] = [
  { key: 'disallowCopy', label: 'Disallow others from copying my experiments' },
  { key: 'disallowNotification', label: "Don't notify me about comments / ratings" },
  { key: 'disallowNewsletter', label: 'Unsubscribe from the newsletter' },
];

const NavTab = styled.button<{ $active: boolean }>`
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 8px 4px;
  font-size: 15px;
  cursor: pointer;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  color: ${(p) => (p.$active ? 'var(--ifi-teal)' : 'var(--ifi-ink)')};
  &:hover {
    color: var(--ifi-teal-dark);
  }
`;

const NavLink = styled.a`
  display: block;
  padding: 8px 4px;
  font-size: 15px;
  font-weight: 400;
`;

const Settings = () => {
  const isMobile = useIsMobile();
  const user = useCommonStore((state) => state.user);
  const [tab, setTab] = useState<Tab>('general');
  const [displayName, setDisplayName] = useState('');
  const [prefs, setPrefs] = useState<UserPrefs>({});
  const [stats, setStats] = useState<UserStats>({ clips: null, comments: null });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    getUserProfile(user.id)
      .then((p) => {
        setDisplayName(p?.displayName ?? user.displayName ?? '');
        setPrefs(p?.prefs ?? {});
      })
      .catch((e) => console.error('failed to load profile', e))
      .finally(() => setLoading(false));
    getUserStats(user.id)
      .then(setStats)
      .catch((e) => console.error('failed to load stats', e));
  }, [user]);

  const onSave = async () => {
    if (!user || saving) return;
    setSaving(true);
    try {
      await updateUserProfile(user.id, { displayName, prefs });
      useCommonStore.getState().setUser({ ...user, displayName });
      message.success('Settings saved');
    } catch (e) {
      console.error('failed to save settings', e);
      message.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!user) return <div style={{ padding: 24 }}>Please sign in to edit your settings.</div>;
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  const toggle = (key: keyof UserPrefs) => (checked: boolean) => setPrefs((p) => ({ ...p, [key]: checked }));

  // Sidebar identity reflects the *saved* name (updates on Save), not the in-progress field.
  const name = user.displayName || user.email || 'Anonymous';
  const initial = (user.displayName || user.email || '?').trim().charAt(0).toUpperCase();
  const stat = (n: number | null) => (n == null ? '—' : n);

  const saveButton = (
    <Button type="primary" loading={saving} onClick={onSave}>
      Save
    </Button>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        gap: isMobile ? 16 : 32,
        padding: 24,
      }}
    >
      <aside
        style={{
          width: isMobile ? '100%' : 256,
          flexShrink: 0,
          padding: 20,
          background: 'var(--ifi-panel)',
          border: '1px solid #e8e8e8',
          borderRadius: 8,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <Avatar
            size={140}
            src={user.avatar || undefined}
            icon={initial === '?' ? <UserOutlined /> : undefined}
            style={{ backgroundColor: 'var(--ifi-teal)', fontSize: 56 }}
          >
            {initial !== '?' ? initial : undefined}
          </Avatar>
          <h3 style={{ margin: '16px 0 4px' }}>{name}</h3>
          {/* mongoId is a fixed-length 24-char hex ObjectId, so nowrap reliably keeps it on one line. */}
          <div style={{ fontSize: 11, color: 'var(--ifi-grey)', whiteSpace: 'nowrap' }}>Telelab ID: {user.id}</div>
          <div style={{ fontSize: 13, marginTop: 6, color: 'var(--ifi-grey)' }}>
            Clips: {stat(stats.clips)}, Comments: {stat(stats.comments)}
          </div>
        </div>

        <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid #eee' }} />

        <nav>
          <NavTab $active={tab === 'general'} onClick={() => setTab('general')}>
            General
          </NavTab>
          <NavTab $active={tab === 'permissions'} onClick={() => setTab('permissions')}>
            Permissions
          </NavTab>
          <NavLink href={TERMS_URL} target="_blank" rel="noopener noreferrer">
            Terms of Service
          </NavLink>
          <NavLink href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </NavLink>
        </nav>
      </aside>

      <main style={{ flex: 1, minWidth: isMobile ? 0 : 320, maxWidth: isMobile ? '100%' : 640 }}>
        {tab === 'general' ? (
          <Form
            layout={isMobile ? 'vertical' : 'horizontal'}
            labelCol={isMobile ? undefined : { flex: '120px' }}
            labelAlign="left"
          >
            <Form.Item label="Display name" extra="Display a nickname as the owner of your experiment pages.">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ maxWidth: 320 }} />
            </Form.Item>
            <Form.Item label=" " colon={false}>
              {saveButton}
            </Form.Item>
          </Form>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {PERMISSIONS.map((p) => (
              <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                <Switch checked={!!prefs[p.key]} onChange={toggle(p.key)} />
                <span>{p.label}</span>
              </label>
            ))}
            <div style={{ marginTop: 8 }}>{saveButton}</div>
          </div>
        )}
      </main>
    </div>
  );
};

export default Settings;
