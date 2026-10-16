/*
 * The one question before a project's first turn: may its data go to the
 * AI provider? The app's ProjectConsentDialog, word for word: the sheet
 * names what is sent and to whom, and the button only unlocks behind a
 * tick. The caller records the agreement (consent.ts) before it sends.
 */

import { useEffect, useState } from 'react';
import { Button, Checkbox, Modal } from 'antd';
import styled from 'styled-components';

const Body = styled.div`
  .cd-text {
    font-size: 15px;
    line-height: 1.5;
    color: var(--ifi-ink);
    margin: 0 0 14px;
  }
  .cd-check {
    font-size: 13.5px;
    color: var(--ifi-text-secondary);
  }
  .cd-error {
    margin-top: 10px;
    font-size: 13px;
    color: var(--ifi-danger);
  }
`;

const ConsentDialog = ({
  open,
  provider,
  onCancel,
  onAgree,
}: {
  open: boolean;
  /** Who runs the project's model, as the project page names it ("OpenAI", "Google"). */
  provider: string;
  onCancel: () => void;
  /** Rejects with a message to keep the dialog open and show why. */
  onAgree: () => Promise<void>;
}) => {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setAgreed(false);
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const agree = async () => {
    if (!agreed || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAgree();
    } catch (e) {
      setError((e as Error)?.message ?? "Couldn't save your agreement. Try again.");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Send this project to the AI?"
      onCancel={busy ? undefined : onCancel}
      closable={!busy}
      maskClosable={false}
      width={440}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>,
        <Button key="agree" type="primary" onClick={agree} disabled={!agreed} loading={busy}>
          Agree & Send
        </Button>,
      ]}
    >
      <Body>
        <p className="cd-text">
          {`This project's thermal data, photos, your notes and your messages are sent to ${provider} to run the AI. Nothing is sent until you agree.`}
        </p>
        <Checkbox className="cd-check" checked={agreed} disabled={busy} onChange={(e) => setAgreed(e.target.checked)}>
          {`I agree to send this data to ${provider}.`}
        </Checkbox>
        {error && <div className="cd-error">{error}</div>}
      </Body>
    </Modal>
  );
};

export default ConsentDialog;
