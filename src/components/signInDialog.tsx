import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Modal, message } from 'antd';
import { AppleFilled, GoogleOutlined } from '@ant-design/icons';
import {
  AccountExistsError,
  PROVIDER_LABEL,
  SignInProvider,
  getSignInPrompt,
  isSignInCancelled,
  settleSignInPrompt,
  signInWithProvider,
  subscribeSignInPrompt,
} from '../services/auth';
import { PRIVACY_URL, TERMS_URL } from '../utils/urls';

/*
 * The one sign-in chooser. Every "Sign in" affordance on the site (header button, the analyzer's
 * comment / rating / save prompts, the delete-account page) calls services/auth signIn(), which
 * opens this dialog; the provider popup itself only runs once the user has picked a method here.
 * Mounted once in the Layout so the choice looks the same everywhere.
 *
 * An email collision (AccountExistsError) is resolved in place: the dialog explains which method
 * the existing account uses, and picking that one both signs the user in and attaches the method
 * they first tried — no separate "link accounts" errand.
 */

const describeFailure = (e: unknown, provider: SignInProvider): string => {
  const label = PROVIDER_LABEL[provider];
  switch ((e as { code?: string } | null)?.code) {
    case 'auth/operation-not-allowed':
      return `Sign in with ${label} isn’t enabled for this site yet.`;
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    case 'auth/network-request-failed':
      return 'The sign-in could not reach the server. Check your connection and try again.';
    default:
      return `Sign in with ${label} failed. Please try again.`;
  }
};

const SignInDialog = () => {
  const { open } = useSyncExternalStore(subscribeSignInPrompt, getSignInPrompt);
  const [busy, setBusy] = useState<SignInProvider | null>(null);
  const [conflict, setConflict] = useState<AccountExistsError | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setBusy(null);
    setConflict(null);
    setError(null);
  };

  const choose = async (provider: SignInProvider) => {
    if (busy) return;
    setBusy(provider);
    setError(null);
    try {
      const { linked } = await signInWithProvider(provider);
      reset();
      settleSignInPrompt(true);
      if (linked) message.success(`${PROVIDER_LABEL[linked]} has been added to your account.`);
    } catch (e) {
      setBusy(null);
      if (isSignInCancelled(e)) return;
      if (e instanceof AccountExistsError) {
        setConflict(e);
        return;
      }
      console.error('sign-in failed', e);
      setError(describeFailure(e, provider));
    }
  };

  const dismiss = () => {
    if (busy) return; // the popup owns the moment; closing underneath it would orphan the result
    reset();
    settleSignInPrompt(false);
  };

  return (
    <Modal
      open={open}
      onCancel={dismiss}
      closable={!busy}
      maskClosable={!busy}
      footer={null}
      title="Sign in"
      width={380}
      centered
    >
      {conflict && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`This email already has an account`}
          description={
            <>
              {conflict.email ? <b>{conflict.email}</b> : 'It'} signs in with {PROVIDER_LABEL[conflict.existing]}.
              Continue with {PROVIDER_LABEL[conflict.existing]} and {PROVIDER_LABEL[conflict.attempted]} will be added
              to that account, so either works from now on.
            </>
          }
        />
      )}
      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Button
          size="large"
          block
          icon={<GoogleOutlined />}
          loading={busy === 'google'}
          disabled={busy !== null && busy !== 'google'}
          type={conflict?.existing === 'google' ? 'primary' : 'default'}
          onClick={() => choose('google')}
        >
          Continue with Google
        </Button>
        {/* Apple's mark is always drawn on black — the one styling its guidelines insist on. */}
        <Button
          size="large"
          block
          icon={<AppleFilled />}
          loading={busy === 'apple'}
          disabled={busy !== null && busy !== 'apple'}
          onClick={() => choose('apple')}
          style={{ background: '#000', borderColor: '#000', color: '#fff' }}
        >
          Continue with Apple
        </Button>
      </div>

      {/* Consent notice at the point of collection — nothing sits between these buttons and the
          provider popup, so this is where the site says what signing in agrees to. */}
      <p style={{ margin: '14px 0 0', fontSize: 12, lineHeight: 1.4, color: 'var(--ifi-text-tertiary)' }}>
        By signing in you agree to the{' '}
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
          Terms of Service
        </a>{' '}
        and{' '}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </a>
        . One account can use both methods — add the other one later under Settings › Sign-in methods.
      </p>
    </Modal>
  );
};

export default SignInDialog;
