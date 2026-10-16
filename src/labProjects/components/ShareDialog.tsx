/*
 * The owner's Share panel, as the app's ShareProjectDialog: Private / Link
 * Only / Public, the link with Copy Link while the project is shared, and
 * what staff did to it. The first switch out of Private passes the site's
 * UGC terms record (the caller's onVisibility does that: services/
 * ugcConsent.ts, the same users/{mongoId}/consents/ugcTerms document the
 * app's Terms sheet writes). Captures are not uploaded from here — the
 * website has none of its own yet; the app's upload while it is shared.
 */

import { useEffect, useState } from 'react';
import { Button, Input, Modal, Spin, message } from 'antd';
import { Copy } from 'lucide-react';
import styled from 'styled-components';
import type { Project, ShareVisibility } from '../core/types';
import { SHARE_TIERS, TAKEN_DOWN } from '../shareTiers';

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;

  .sd-tier {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: none;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .sd-tier:hover:not(:disabled) {
    background: var(--ifi-fill-1);
  }
  .sd-tier.on {
    background: var(--ifi-teal-film);
    border-color: var(--ifi-teal);
  }
  .sd-tier:disabled {
    cursor: default;
  }
  .sd-tier.waiting {
    opacity: 0.5;
  }
  .sd-icon {
    flex: none;
    color: var(--ifi-text-secondary);
  }
  .sd-tier.on .sd-icon {
    color: var(--ifi-teal-dark);
  }
  .sd-text {
    flex: 1;
    min-width: 0;
  }
  .sd-label {
    font-size: 15px;
    font-weight: 600;
    color: var(--ifi-ink);
  }
  .sd-hint {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ifi-text-secondary);
  }
  .sd-tier.off .sd-label,
  .sd-tier.off .sd-hint,
  .sd-tier.off .sd-icon {
    color: var(--ifi-text-tertiary);
  }
  .sd-link {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .sd-note {
    margin: 12px 0 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ifi-text-tertiary);
  }
  .sd-error {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--ifi-danger);
  }
`;

const ShareDialog = ({
  open,
  project,
  onClose,
  onVisibility,
}: {
  open: boolean;
  project: Project;
  onClose: () => void;
  /** Rejects with a message to show. */
  onVisibility: (v: ShareVisibility) => Promise<void>;
}) => {
  const current: ShareVisibility = project.share?.visibility ?? 'private';
  const takenDown = project.share?.takenDown === true;
  const [busy, setBusy] = useState<ShareVisibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setBusy(null);
    }
  }, [open]);

  const pick = async (v: ShareVisibility) => {
    if (busy || v === current) {
      return;
    }
    if (v === 'public' && takenDown) {
      setError(TAKEN_DOWN);
      return;
    }
    setBusy(v);
    setError(null);
    try {
      await onVisibility(v);
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not change the sharing.');
    } finally {
      setBusy(null);
    }
  };

  const url = project.share?.url ?? '';
  const copy = () => {
    navigator.clipboard
      .writeText(url)
      .then(() => message.success('Link copied.'))
      .catch(() => message.error('Could not copy the link.'));
  };

  return (
    <Modal
      open={open}
      title="Share Project"
      onCancel={onClose}
      width={480}
      footer={[
        <Button key="done" type="primary" onClick={onClose}>
          Done
        </Button>,
      ]}
    >
      <Body>
        {SHARE_TIERS.map((tier) => {
          const Icon = tier.icon;
          const on = current === tier.key;
          const off = tier.key === 'public' && takenDown;
          const saving = busy === tier.key;
          const cls = ['sd-tier', on ? 'on' : '', off ? 'off' : '', busy != null && !saving ? 'waiting' : ''].join(' ');
          return (
            <button
              key={tier.key}
              type="button"
              className={cls}
              onClick={() => pick(tier.key)}
              disabled={busy != null || off}
              role="radio"
              aria-checked={on}
            >
              <Icon size={20} className="sd-icon" />
              <span className="sd-text">
                <span className="sd-label">{tier.label}</span>
                <br />
                <span className="sd-hint">{off ? TAKEN_DOWN : tier.hint}</span>
              </span>
              {saving && <Spin size="small" />}
            </button>
          );
        })}
        {current !== 'private' && url && (
          <div className="sd-link">
            <Input value={url} readOnly onFocus={(e) => e.target.select()} />
            <Button icon={<Copy size={15} />} onClick={copy}>
              Copy Link
            </Button>
          </div>
        )}
        <p className="sd-note">
          Viewers see the conversation, the plan, the report and the captures the app has uploaded. A capture still on
          the phone shows as not shared until it is uploaded from the app.
        </p>
        {error && <p className="sd-error">{error}</p>}
      </Body>
    </Modal>
  );
};

export default ShareDialog;
