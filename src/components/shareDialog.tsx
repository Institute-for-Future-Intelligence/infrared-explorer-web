/*
 * The Share panel — one panel for everything the cloud holds (a recording, an
 * AI experiment, a street view): "Who Can Open It" with the tiers
 * (visibilityControl VISIBILITY_OPTIONS), the link and the ways to pass it
 * on (shareMenu ShareLinkPanel) while someone else can open it, and whatever
 * the kind adds below. The app's components/share/ShareDialog is the same
 * panel on a phone.
 *
 * The rules every kind shares live here once: a click on a tier only ticks
 * it, Save sends it to the server through `onVisibility` (user's call
 * 2026-10-19: nothing changes until it is confirmed); the first
 * switch out of Private records the site's UGC terms consent (services/
 * ugcConsent.ts, the same users/{mongoId}/consents/ugcTerms document the
 * app's Terms sheet writes); a tier staff blocked (`blocked`) is greyed with
 * the reason in place of its hint.
 *
 * Wording (user's call 2026-10-19): the entrance is "Share…" and this panel
 * is "Share <Noun>"; the tiers are the property, named "Visibility" only
 * where it is filtered, sorted or set in bulk.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Button, Modal } from 'antd';
import styled from 'styled-components';
import { Visibility } from '../types';
import useCommonStore from '../stores/common';
import { ensureUgcConsent } from '../services/ugcConsent';
import { ShareLinkPanel } from './shareMenu';
import { VISIBILITY_OPTIONS, tierHint, type ShareKind } from './visibilityControl';

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;

  .sd-section {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--ifi-text-tertiary);
  }
  .sd-tier {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
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
    margin-top: 10px;
    padding-top: 12px;
    border-top: 1px solid var(--ifi-stroke-1);
  }
  .sd-link > div {
    width: 100%;
  }
  .sd-note {
    margin: 12px 0 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ifi-text-tertiary);
  }
  .sd-extra {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--ifi-stroke-1);
  }
  .sd-error {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--ifi-danger);
  }
`;

const ShareDialog = ({
  open,
  title,
  kind,
  tiers,
  current,
  url,
  linkTitle,
  blocked,
  onVisibility,
  onClose,
  note,
  children,
}: {
  open: boolean;
  /** "Share Recording", "Share Experiment", "Share Street View". */
  title: string;
  kind: ShareKind;
  /** The tiers offered; default all three. */
  tiers?: readonly Visibility[];
  current: Visibility;
  /** The link; null when the kind has none to hand out. Shown while the tier is not Private. */
  url: string | null;
  /** The text a network pre-fills beside the link: the item's title. */
  linkTitle: string;
  /** A tier that cannot be chosen, with why. */
  blocked?: Partial<Record<Visibility, string>>;
  /** Writes the tier; rejects with a message to show. */
  onVisibility: (v: Visibility) => Promise<void>;
  onClose: () => void;
  /** A line under the tiers (what viewers see, say). */
  note?: ReactNode;
  /** The kind's own section, under the link. */
  children?: ReactNode;
}) => {
  const user = useCommonStore((state) => state.user);
  // The tier ticked, saved or not; Save sends it, Cancel / a reopen drop it.
  const [pick, setPick] = useState<Visibility>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPick(current);
      setError(null);
      setBusy(false);
    }
  }, [open, current]);

  const tick = (v: Visibility) => {
    const why = blocked?.[v];
    setError(why ?? null);
    if (!why) {
      setPick(v);
    }
  };

  const save = async () => {
    const v = pick;
    if (busy || v === current) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // the first switch out of Private passes the site's UGC terms record
      if (current === Visibility.Private && user) {
        await ensureUgcConsent(user.id);
      }
      await onVisibility(v);
    } catch (e) {
      setError((e as Error)?.message || 'Could not change the sharing.');
    } finally {
      setBusy(false);
    }
  };
  const dirty = pick !== current;

  const rows = tiers ? VISIBILITY_OPTIONS.filter((o) => tiers.includes(o.value)) : VISIBILITY_OPTIONS;

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onClose}
      width={520}
      centered
      // never taller than the window: the body scrolls instead (a small laptop, a long note)
      styles={{ body: { maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' } }}
      footer={
        dirty
          ? [
              <Button key="cancel" onClick={onClose} disabled={busy}>
                Cancel
              </Button>,
              <Button key="save" type="primary" onClick={save} loading={busy}>
                Save
              </Button>,
            ]
          : [
              <Button key="done" type="primary" onClick={onClose}>
                Done
              </Button>,
            ]
      }
    >
      <Body>
        <p className="sd-section">WHO CAN OPEN IT</p>
        {rows.map((tier) => {
          const Icon = tier.icon;
          const on = pick === tier.value;
          const why = blocked?.[tier.value];
          const off = why != null;
          const cls = ['sd-tier', on ? 'on' : '', off ? 'off' : '', busy ? 'waiting' : ''].join(' ');
          return (
            <button
              key={tier.value}
              type="button"
              className={cls}
              onClick={() => tick(tier.value)}
              disabled={busy}
              role="radio"
              aria-checked={on}
            >
              <Icon size={20} className="sd-icon" />
              <span className="sd-text">
                <span className="sd-label">{tier.label}</span>
                <br />
                <span className="sd-hint">{why ?? tierHint(kind, tier.value)}</span>
              </span>
            </button>
          );
        })}
        {/* the link follows the tier ticked, not the one saved: a Private pick hides it, a pick out of
            Private shows it — or says it is a Save away, while the server has minted none yet */}
        {pick !== Visibility.Private &&
          (url ? (
            <div className="sd-link">
              <ShareLinkPanel url={url} title={linkTitle} layout="row" />
            </div>
          ) : (
            <p className="sd-note">The link appears once you save.</p>
          ))}
        {note && <p className="sd-note">{note}</p>}
        {children && <div className="sd-extra">{children}</div>}
        {error && <p className="sd-error">{error}</p>}
      </Body>
    </Modal>
  );
};

export default ShareDialog;
