import { useState } from 'react';
import { Button, Popover, QRCode, Tooltip, message } from 'antd';
import { CheckOutlined, LinkOutlined, ShareAltOutlined } from '@ant-design/icons';
import {
  FacebookIcon,
  FacebookShareButton,
  LineIcon,
  LineShareButton,
  WhatsappIcon,
  WhatsappShareButton,
  XIcon,
  XShareButton,
} from 'react-share';
import styled from 'styled-components';
import { Visibility } from '../types';
import { useIsMobile } from '../hooks/useIsMobile';

interface Props {
  /** Canonical URL to share (build it with the helpers in utils/urls). */
  url: string;
  /** Text a network pre-fills as the post body — the experiment / page title in plain text. */
  title: string;
  /** When set, the popover shows a one-line reach hint (Private / Unlisted links behave differently). */
  visibility?: Visibility;
}

// Quiet grey by default, teal on hover — matches SaveToMyExperiments/the title pencil beside it so the
// header actions read as one restrained toolbar rather than competing with the title.
const TriggerButton = styled(Button)`
  color: var(--ifi-grey);

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
`;

const Panel = styled.div`
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

// Read-only URL + copy button. The URL ellipsizes so a long id never widens the popover.
const UrlRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--ifi-border, #d9d9d9);
  border-radius: 8px;
  padding: 2px 2px 2px 10px;
`;

const UrlText = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--ifi-text-secondary, #595959);
`;

// Reach note: a warning tint for Private (the link won't open for others), muted for Unlisted.
const ReachHint = styled.div<{ $warn?: boolean }>`
  font-size: 12px;
  line-height: 1.4;
  color: ${(p) => (p.$warn ? '#c0392b' : 'var(--ifi-text-tertiary, #767676)')};
`;

const PlatformRow = styled.div`
  display: flex;
  gap: 8px;
  /* Each react-share button wraps a 32px icon in an 8px pad → a ~48px tap target (clears WCAG 2.5.8). */
  .react-share__ShareButton {
    display: inline-flex !important;
    padding: 8px;
    border-radius: 999px;
    transition: background-color 0.15s ease;
  }
  .react-share__ShareButton:hover {
    background: rgba(0, 0, 0, 0.05);
  }
`;

const QrWrap = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
`;

const QrCaption = styled.span`
  font-size: 11px;
  color: var(--ifi-text-tertiary, #767676);
`;

const reachHint = (visibility?: Visibility): { text: string; warn: boolean } | null => {
  if (visibility === Visibility.Private) return { text: 'Private — only you can open this link.', warn: true };
  if (visibility === Visibility.Unlisted) return { text: 'Unlisted — anyone with the link can view.', warn: false };
  return null;
};

/**
 * One Share affordance replacing the old split of a copy-link icon + a separate row of social icons.
 * A quiet "Share" button opens a popover with: the canonical link + copy, an optional reach hint for
 * non-public experiments, a compact set of relevant networks (LINE / WhatsApp / X / Facebook), and a
 * QR code for the classroom (project it, students scan to the exact experiment). On mobile, when the
 * OS share sheet is available, the button calls it directly instead — it carries the full set of the
 * user's own apps (WeChat, LINE, copy, …), a superset of what we could hand-pick.
 */
const ShareMenu = ({ url, title, visibility }: Props) => {
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('failed to copy share link', e);
      message.error('Could not copy the link.');
    }
  };

  const canNativeShare = isMobile && typeof navigator !== 'undefined' && !!navigator.share;

  const nativeShare = async () => {
    try {
      await navigator.share({ title, url });
    } catch (e) {
      // The user dismissing the OS sheet rejects with AbortError — not an error worth surfacing.
      if ((e as DOMException)?.name !== 'AbortError') console.error('native share failed', e);
    }
  };

  const trigger = (
    <TriggerButton type="text" icon={<ShareAltOutlined />} aria-label="Share" style={{ flexShrink: 0 }}>
      Share
    </TriggerButton>
  );

  if (canNativeShare) {
    return (
      <span onClick={nativeShare} style={{ display: 'inline-flex' }}>
        {trigger}
      </span>
    );
  }

  const hint = reachHint(visibility);
  // resetButtonStyle defaults to true (strips native button chrome) so the PlatformRow padding/hover
  // styling applies cleanly — the same reset the old inline-styled share row relied on.
  const shareProps = { url, title } as const;

  const content = (
    <Panel>
      <UrlRow>
        <UrlText title={url}>{url}</UrlText>
        <Tooltip title={copied ? 'Copied' : 'Copy link'} open={copied || undefined}>
          <Button
            type="text"
            size="small"
            icon={copied ? <CheckOutlined style={{ color: 'var(--ifi-teal)' }} /> : <LinkOutlined />}
            onClick={copy}
            aria-label={copied ? 'Copied' : 'Copy link'}
          />
        </Tooltip>
      </UrlRow>

      {hint && <ReachHint $warn={hint.warn}>{hint.text}</ReachHint>}

      <PlatformRow>
        <LineShareButton {...shareProps} aria-label="Share on LINE">
          <LineIcon size={32} round />
        </LineShareButton>
        <WhatsappShareButton {...shareProps} aria-label="Share on WhatsApp">
          <WhatsappIcon size={32} round />
        </WhatsappShareButton>
        <XShareButton {...shareProps} aria-label="Share on X">
          <XIcon size={32} round />
        </XShareButton>
        <FacebookShareButton {...shareProps} aria-label="Share on Facebook">
          <FacebookIcon size={32} round />
        </FacebookShareButton>
      </PlatformRow>

      <QrWrap>
        <QRCode value={url} size={112} bordered={false} />
        <QrCaption>Scan to open on a phone</QrCaption>
      </QrWrap>
    </Panel>
  );

  return (
    <Popover content={content} trigger="click" placement="bottomRight" destroyTooltipOnHide>
      {trigger}
    </Popover>
  );
};

export default ShareMenu;
