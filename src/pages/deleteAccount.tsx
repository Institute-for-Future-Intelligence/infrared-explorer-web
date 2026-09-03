import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Typography, message } from 'antd';
import { ExclamationCircleFilled } from '@ant-design/icons';
import useCommonStore from '../stores/common';
import { isSignInCancelled, signIn } from '../services/auth';
import { deleteMyAccount } from '../services/accountDeletion';
import { submitContact } from '../services/contact';
import { PRIVACY_URL, TERMS_URL } from '../utils/urls';

/*
 * Public account-deletion page — the web resource Google Play's user-data policy requires:
 * a user must be able to REQUEST deletion of their account and data without reinstalling the
 * app. Play checks three things about this page, so keep them true when editing:
 *   1. it loads for signed-out visitors,
 *   2. the deletion path is prominent on it (not buried under other content),
 *   3. it names the app / developer exactly as the store listing does — hence APP_NAME below.
 * It must also never bounce the visitor back into the app to finish, which is why the
 * request form exists for people who cannot sign in here at all.
 *
 * Apple takes the opposite stance: deletion must be INITIATED in the app (Guideline
 * 5.1.1(v)), and a website may only complete a flow the app started. Do not link the iOS app
 * here — its own Account screen is the entry point.
 *
 * Both halves go through the same `deleteAccount` callable as the app, so what this page
 * promises is exactly what the app performs.
 */

// Must match the Google Play store listing verbatim — a mismatch is a documented cause of
// "invalid data deletion link" rejections. Verified 2026-09-01 against the live listing
// (play.google.com/store/apps/details?id=org.intofuture.infraredexplorer): title
// "Infrared Explorer", developer "Institute for Future Intelligence". Update both if the
// listing ever changes.
const APP_NAME = 'Infrared Explorer';
const DEVELOPER_NAME = 'Institute for Future Intelligence';

const { Title, Paragraph, Text } = Typography;

/** What the purge removes, in the user's terms. Mirrors the callable's surfaces. */
const DELETED = [
  'your account record and sign-in',
  'your profile, public profile page, display name and avatar',
  'every recording and experiment you uploaded, including their thermal frames',
  'every street view you uploaded, including its location',
  'comments and ratings you left on other people’s experiments, together with any replies other users made to your comments',
  'your classroom records — memberships, submissions, grades and workspace items',
  'any class you created, together with everything inside it, including work your students submitted (their own experiments stay in their accounts)',
];

/** Honest residue. Both stores allow retention that is disclosed; silence is what they punish. */
const KEPT = [
  'recordings that someone else has copied into their own experiment stay online — deleting them would blank out another person’s work',
  'your name, and the title and description of your experiments, may remain in other people’s notification history and in their private viewing history',
  'files from an upload you cancelled, or that was interrupted before it finished — they were never linked to your account, so deletion cannot find them (ask us and we will remove them)',
  'anything already downloaded or saved to a device by you or anyone else',
];

const DeleteAccountPage = () => {
  const user = useCommonStore((state) => state.user);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [form] = Form.useForm();

  const confirmAndDelete = () => {
    Modal.confirm({
      title: 'Delete this account permanently?',
      icon: <ExclamationCircleFilled />,
      okText: 'Delete my account',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      content: (
        <>
          <p>
            Everything you have uploaded is deleted from the cloud and cannot be recovered. You will be asked to sign in
            once more to confirm it is you.
          </p>
        </>
      ),
      onOk: async () => {
        setBusy(true);
        try {
          await deleteMyAccount();
          setDone(true);
        } catch (e) {
          console.error('failed to delete account', e);
          if (isSignInCancelled(e)) {
            message.info('Deletion cancelled — nothing was changed.');
          } else {
            message.error(
              'The account could not be deleted. Please try again, or use the request form below and we will do it for you.',
            );
          }
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const sendRequest = async (values: { email: string; note?: string }) => {
    setBusy(true);
    try {
      await submitContact(
        'Account deletion request',
        values.email,
        `Please delete my ${APP_NAME} account and all of its data.\n\n${values.note ?? ''}`.trim(),
      );
      setRequestSent(true);
      form.resetFields();
    } catch (e) {
      console.error('failed to submit deletion request', e);
      message.error('The request could not be sent. Please try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '8px 16px 48px' }}>
      <Title level={2} style={{ marginBottom: 4 }}>
        Delete your {APP_NAME} account
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 24 }}>
        {APP_NAME} — {DEVELOPER_NAME}. This page deletes the account you use in the {APP_NAME} app and on this site,
        together with the data it holds. You do not need the app installed to use it.
      </Paragraph>

      {done ? (
        <Alert
          type="success"
          showIcon
          message="Your account has been deleted."
          description="The account, and everything it had uploaded, is gone. You can close this page. Signing in again would create a brand-new account."
        />
      ) : (
        <>
          <Title level={4}>Delete it now</Title>
          {user ? (
            <>
              <Paragraph>
                {/* The address, not the nickname — it is what tells two of your accounts apart on the
                    one screen where picking the wrong one is unrecoverable. Apple's relay address is
                    40 unbreakable characters, so let it wrap rather than run off a phone screen. */}
                Signed in as{' '}
                <Text strong style={{ overflowWrap: 'anywhere' }}>
                  {user.email ?? user.displayName ?? 'your account'}
                </Text>
                .
              </Paragraph>
              <Button danger type="primary" size="large" loading={busy} onClick={confirmAndDelete}>
                Delete my account
              </Button>
            </>
          ) : (
            <>
              <Paragraph>Sign in with the account you want to delete, then confirm on the next step.</Paragraph>
              <Button
                type="primary"
                size="large"
                onClick={() => {
                  signIn().catch((e) => {
                    if (isSignInCancelled(e)) return;
                    console.error('sign-in failed', e);
                    message.error('Sign-in failed. You can also use the request form below.');
                  });
                }}
              >
                Sign in to continue
              </Button>
              <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
                By signing in you agree to the{' '}
                <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
                  Terms of Service
                </a>{' '}
                and{' '}
                <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
                  Privacy Policy
                </a>
                .
              </Paragraph>
            </>
          )}

          <Title level={4} style={{ marginTop: 32 }}>
            What is deleted
          </Title>
          <ul>
            {DELETED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Paragraph type="secondary">
            Deletion is immediate and permanent — there is no waiting period and no way to restore the data afterwards.
            The full retention and deletion terms are in the{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </Paragraph>

          <Title level={5}>What stays</Title>
          <ul>
            {KEPT.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <Title level={4} style={{ marginTop: 32 }}>
            Can’t sign in here?
          </Title>
          <Paragraph>
            If you cannot sign in above — with Google or with Apple — for any reason, send the request here instead. We
            delete the account and confirm by email, normally within a few days.
          </Paragraph>
          {requestSent ? (
            <Alert
              type="success"
              showIcon
              message="Request received."
              description="We will delete the account and email you when it is done."
            />
          ) : (
            <Form form={form} layout="vertical" onFinish={sendRequest} style={{ maxWidth: 480 }}>
              <Form.Item
                name="email"
                label="The email address of the account"
                rules={[
                  { required: true, message: 'Please enter the account’s email address.' },
                  { type: 'email', message: 'Please enter a valid email address.' },
                ]}
              >
                <Input placeholder="you@example.com" />
              </Form.Item>
              <Form.Item name="note" label="Anything else we should know (optional)">
                <Input.TextArea rows={3} placeholder="Optional" />
              </Form.Item>
              <Form.Item>
                <Button htmlType="submit" loading={busy}>
                  Request deletion
                </Button>
              </Form.Item>
            </Form>
          )}
        </>
      )}
    </div>
  );
};

export default DeleteAccountPage;
