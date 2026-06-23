import { useEffect, useState } from 'react';
import { Button, Form, Input, Switch, message } from 'antd';
import useCommonStore from '../stores/common';
import { getUserProfile, updateUserProfile, UserPrefs } from '../services/account';

const Settings = () => {
  const user = useCommonStore((state) => state.user);
  const [displayName, setDisplayName] = useState('');
  const [prefs, setPrefs] = useState<UserPrefs>({});
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

  return (
    <Form layout="vertical" style={{ maxWidth: 420, padding: 24 }}>
      <Form.Item label="Display name">
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </Form.Item>
      <Form.Item label="Email">
        <Input value={user.email ?? ''} disabled />
      </Form.Item>
      <Form.Item label="Disallow others from copying my experiments">
        <Switch checked={!!prefs.disallowCopy} onChange={toggle('disallowCopy')} />
      </Form.Item>
      <Form.Item label="Don't notify me about comments / ratings">
        <Switch checked={!!prefs.disallowNotification} onChange={toggle('disallowNotification')} />
      </Form.Item>
      <Form.Item label="Unsubscribe from the newsletter">
        <Switch checked={!!prefs.disallowNewsletter} onChange={toggle('disallowNewsletter')} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" loading={saving} onClick={onSave}>
          Save
        </Button>
      </Form.Item>
    </Form>
  );
};

export default Settings;
