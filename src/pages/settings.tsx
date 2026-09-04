import { useEffect, useState } from 'react';
import { Avatar, Button, Form, Input, Modal, Switch, message } from 'antd';
import { AppleFilled } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import GoogleGSVG from '../assets/google-g.svg?react';
import useCommonStore from '../stores/common';
import { getUserProfile, getUserStats, updateUserProfile, UserPrefs, UserStats } from '../services/account';
import {
  PROVIDER_LABEL,
  SIGN_IN_PROVIDERS,
  SignInProvider,
  isSignInCancelled,
  linkProvider,
  linkedProviderEmail,
  linkedProviders,
  unlinkProvider,
} from '../services/auth';
import { useIsMobile } from '../hooks/useIsMobile';
import { userDisplayName } from '../utils/displayName';
import { PRIVACY_URL, TERMS_URL } from '../utils/urls';

/*
 * Account settings — ported from Telelab for parity: a profile sidebar (avatar, name,
 * Telelab ID, clip/comment counts) beside a tabbed pane. "General" edits the display
 * nickname; "Permissions" holds the privacy/notification toggles; "Sign-in methods" links /
 * unlinks Google and Apple on the one account; Terms of Service and Privacy Policy are
 * external links. Telelab's "Rooms" section is omitted — it belonged to the live-streaming
 * feature dropped in this migration (docs/telelab-migration.md).
 */

type Tab = 'general' | 'permissions' | 'signin';

// Only the toggle that something actually enforces. `disallowCopy` and `disallowNewsletter`
// were Telelab-era rows: nothing in the rules or the clone paths reads disallowCopy, and no
// newsletter is sent from this codebase — offering either would promise a control that does
// not exist, which the privacy policy (ie.intofuture.org/privacy) must not do. The stored
// fields stay in UserPrefs for backward compatibility with existing user docs.
const PERMISSIONS: { key: keyof UserPrefs; label: string }[] = [
  { key: 'disallowNotification', label: "Don't notify me about comments / ratings" },
];

const PROVIDER_ICON: Record<SignInProvider, JSX.Element> = {
  google: <GoogleGSVG width={22} height={22} style={{ flexShrink: 0 }} />,
  apple: <AppleFilled style={{ fontSize: 22 }} />,
};

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
  // Sign-in methods come from the Firebase user, not the store user (which carries no
  // providerData); re-read after every link/unlink and whenever the session changes.
  const [linked, setLinked] = useState<SignInProvider[]>([]);
  const [linkBusy, setLinkBusy] = useState<SignInProvider | null>(null);

  useEffect(() => {
    setLinked(linkedProviders());
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
    // One Save button serves both the General (name) and Permissions (prefs) tabs, so an empty
    // name must NOT block the save — the prefs still need to persist. Send the name only when
    // it's non-empty (updateUserProfile refuses to blank it anyway); prefs always go.
    const trimmedName = displayName.trim();
    setSaving(true);
    try {
      await updateUserProfile(user.id, { ...(trimmedName ? { displayName: trimmedName } : {}), prefs });
      if (trimmedName) useCommonStore.getState().setUser({ ...user, displayName: trimmedName });
      message.success(trimmedName ? 'Settings saved' : 'Saved. Display name left unchanged — it can’t be empty.');
    } catch (e) {
      console.error('failed to save settings', e);
      message.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Attach another way in. The identity may already belong to a DIFFERENT account (someone who
  // signed up with Apple in the app and with Google here owns two) — Firebase refuses, and since
  // accounts cannot be merged from the client the dialog says which one to keep using.
  const link = async (provider: SignInProvider) => {
    const label = PROVIDER_LABEL[provider];
    setLinkBusy(provider);
    try {
      await linkProvider(provider);
      setLinked(linkedProviders());
      message.success(`${label} added — you can now sign in with it too.`);
    } catch (e) {
      if (isSignInCancelled(e)) return;
      console.error(`failed to link ${provider}`, e);
      const code = (e as { code?: string }).code;
      if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
        Modal.warning({
          title: `That ${label} identity already has its own account`,
          content: (
            <p>
              The {label} account you chose is already attached to a different Infrared Explorer account, and two
              accounts can’t be merged. Sign out and sign in with {label} to use that one, or keep using this account
              with the methods listed here.
            </p>
          ),
        });
      } else if (code === 'auth/provider-already-linked') {
        setLinked(linkedProviders());
      } else if (code === 'auth/operation-not-allowed') {
        message.error(`Sign in with ${label} isn’t enabled for this site yet.`);
      } else {
        message.error(`Could not add ${label}. Please try again.`);
      }
    } finally {
      setLinkBusy(null);
    }
  };

  const remove = (provider: SignInProvider) => {
    const label = PROVIDER_LABEL[provider];
    const remaining = linked.filter((p) => p !== provider).map((p) => PROVIDER_LABEL[p]);
    Modal.confirm({
      title: `Remove ${label} from this account?`,
      content: `You will no longer be able to sign in with ${label}, here or in the app. ${remaining.join(' and ')} keeps working.`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await unlinkProvider(provider);
          setLinked(linkedProviders());
          message.success(`${label} removed.`);
        } catch (e) {
          console.error(`failed to unlink ${provider}`, e);
          message.error((e as Error).message || `Could not remove ${label}.`);
        }
      },
    });
  };

  if (!user) return <div style={{ padding: 24 }}>Please sign in to edit your settings.</div>;
  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  const toggle = (key: keyof UserPrefs) => (checked: boolean) => setPrefs((p) => ({ ...p, [key]: checked }));

  // Sidebar identity reflects the *saved* name (updates on Save), not the in-progress field. Never
  // the email address: an Apple relay address is 40 unbreakable characters and overflowed the
  // 256px sidebar — utils/displayName hands out a real name instead.
  const name = userDisplayName(user);
  const initial = name.charAt(0).toUpperCase();
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
            style={{ backgroundColor: 'var(--ifi-teal)', fontSize: 56 }}
          >
            {initial}
          </Avatar>
          {/* A name the user typed can still be one long word — wrap it rather than let it escape
              the sidebar (which is what the email fallback used to do). */}
          <h3 style={{ margin: '16px 0 4px', overflowWrap: 'anywhere' }}>{name}</h3>
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
          <NavTab $active={tab === 'signin'} onClick={() => setTab('signin')}>
            Sign-in methods
          </NavTab>
          <NavLink href={TERMS_URL} target="_blank" rel="noopener noreferrer">
            Terms of Service
          </NavLink>
          <NavLink href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </NavLink>
          {/* Both stores want account deletion to be easy to find from account settings —
              this is that entry point on the web (the app has its own on its Account screen). */}
          <NavLink as={Link} to="/delete-account" style={{ color: 'var(--ifi-danger)' }}>
            Delete account
          </NavLink>
        </nav>
      </aside>

      <main style={{ flex: 1, minWidth: isMobile ? 0 : 320, maxWidth: isMobile ? '100%' : 640 }}>
        {tab === 'general' && (
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
        )}
        {tab === 'permissions' && (
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
        {tab === 'signin' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: '0 0 4px', color: 'var(--ifi-grey)' }}>
              Every method listed here signs you in to this same account — on this site and in the Infrared Explorer
              app. Link the other one so you are never locked out of your data.
            </p>
            {SIGN_IN_PROVIDERS.map((provider) => {
              const isLinked = linked.includes(provider);
              const email = isLinked ? linkedProviderEmail(provider) : null;
              return (
                <div
                  key={provider}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '12px 16px',
                    background: 'var(--ifi-panel)',
                    border: '1px solid #e8e8e8',
                    borderRadius: 8,
                  }}
                >
                  {PROVIDER_ICON[provider]}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{PROVIDER_LABEL[provider]}</div>
                    {/* Apple's address may be a private relay one — shown as-is, it is still the
                        address that tells the two Apple IDs in a family apart. */}
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--ifi-grey)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {isLinked ? (email ?? 'Linked') : 'Not linked'}
                    </div>
                  </div>
                  {isLinked ? (
                    <Button danger disabled={linked.length <= 1} onClick={() => remove(provider)}>
                      Remove
                    </Button>
                  ) : (
                    <Button
                      type="primary"
                      loading={linkBusy === provider}
                      disabled={linkBusy !== null && linkBusy !== provider}
                      onClick={() => link(provider)}
                    >
                      Link
                    </Button>
                  )}
                </div>
              );
            })}
            {linked.length <= 1 && (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--ifi-grey)' }}>
                Your only sign-in method can’t be removed — link the other one first.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Settings;
