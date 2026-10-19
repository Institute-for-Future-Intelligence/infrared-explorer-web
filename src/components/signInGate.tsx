import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from 'antd';
import useCommonStore from '../stores/common';
import { isSignInCancelled, signIn } from '../services/auth';

interface Options {
  /** The prompt's title, e.g. "Sign in to save". */
  title: string;
  /** Why the action needs an account, and what happens once they have one. */
  text: string;
}

/**
 * An action that needs an account, for a control signed-out visitors still see (they are the audience
 * most likely to want to keep something public). `gate(action)` runs the action at once when signed in;
 * signed out, it opens an explanatory prompt (not a surprise OAuth popup) whose own Sign in button
 * carries the flow through: once the app's auth listener hydrates the store user, the action the visitor
 * asked for runs by itself, so their intent survives the auth round-trip.
 *
 * Render `dialog` once in the tree that calls `gate`.
 */
export function useSignInGate({ title, text }: Options) {
  const user = useCommonStore((state) => state.user);
  const [open, setOpen] = useState(false);
  // The popup-in-flight flag that drives the button spinner.
  const [signingIn, setSigningIn] = useState(false);
  // The action the visitor asked for; `resume` is set once the popup resolves and consumed by the
  // user-arrival effect below.
  const pending = useRef<(() => void) | null>(null);
  const resume = useRef<(() => void) | null>(null);

  const gate = (action: () => void) => {
    if (useCommonStore.getState().user) {
      action();
      return;
    }
    pending.current = action;
    setOpen(true);
  };

  // The prompt's Sign in button: open the provider chooser, then keep the prompt open (button still
  // spinning) until the app's auth listener hydrates the store user — signIn() resolves when the
  // provider popup does, BEFORE onAuthStateChanged finishes resolving the mongoId/profile (see
  // services/auth.ts), so the effect below is what actually completes the flow. A dismissed chooser
  // or popup just resets the button.
  const handleSignIn = async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      await signIn();
      resume.current = pending.current;
    } catch (e) {
      if (!isSignInCancelled(e)) console.error('sign-in failed', e);
      setSigningIn(false);
    }
  };

  // Cancel (or the X) also withdraws the pending resume, so a popup that already resolved won't run
  // the action after the visitor changed their mind.
  const cancel = () => {
    setOpen(false);
    setSigningIn(false);
    pending.current = null;
    resume.current = null;
  };

  useEffect(() => {
    const fn = resume.current;
    if (!user || !fn) return;
    pending.current = null;
    resume.current = null;
    setOpen(false);
    setSigningIn(false);
    fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const dialog: ReactNode = (
    <Modal
      title={title}
      open={open}
      onOk={handleSignIn}
      onCancel={cancel}
      okText="Sign in"
      okButtonProps={{ loading: signingIn }}
      destroyOnHidden
    >
      <p style={{ marginTop: 0 }}>{text}</p>
    </Modal>
  );

  return { gate, dialog };
}
