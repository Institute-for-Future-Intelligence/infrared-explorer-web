import { useState, type ReactNode } from 'react';
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
import { tierHint } from './visibilityControl';

interface Props {
  /** Canonical URL to share (build it with the helpers in utils/urls). */
  url: string;
  /** Text a network pre-fills as the post body — the experiment / page title in plain text. */
  title: string;
  /** When set, the popover shows a one-line reach hint (Private / Link Only links behave differently). */
  visibility?: Visibility;
  /** Icon-only trigger, its label moved into a tooltip — for narrow headers where the text would
      crowd out the page/experiment title. */
  compact?: boolean;
  /** Opens something else (the owner's Share panel) in place of the link popover. */
  onClick?: () => void;
  /** How the item is shared now, said by the button itself (the owner's). */
  state?: ShareState;
}

/**
 * What the owner's Share button says in place of "Share": the tier's glyph and its name ("Link Only"),
 * so the state and the way to change it are one button. "Share" moves into the tooltip.
 */
export interface ShareState {
  icon: ReactNode;
  /** "Private", "Link Only", "Public". */
  label: string;
  /** What the tier means, for the tooltip. */
  hint: string;
  /** Someone else can open it: the button is drawn in teal. */
  open?: boolean;
  /** Staff took it down: the button is drawn in red. */
  down?: boolean;
}

/**
 * A title row narrower than this keeps the Share button's glyph and drops its words, so the title
 * keeps its room — the same on a recording's page and an experiment's.
 */
export const SHARE_NAME_MIN_PX = 440;

// Quiet grey by default, teal on hover — matches the ⋮ (moreButton) and the title pencil beside it so
// the header actions read as one restrained toolbar rather than competing with the title.
const TriggerButton = styled(Button)`
  color: var(--ifi-grey);

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
  /* With a state, the button is the tier's glyph and name on the tier's tint: grey for Private, teal
     while someone else can open the item, red once staff took it down. One button, with no "Share"
     beside it — a chip inside a Share button read as a second control. */
  &.has-state {
    --state-ink: var(--ifi-text-secondary);
    --state-bg: var(--ifi-fill-1);
    /* a little under the ⋮ beside it: a filled block the row's full 32px read heavier than the title */
    height: 28px;
    padding-inline: 10px;
    font-weight: 500;
  }
  &.has-state.ant-btn-icon-only {
    width: 28px;
    padding-inline: 0;
  }
  &.has-state.is-open {
    --state-ink: var(--ifi-teal-dark);
    --state-bg: var(--ifi-teal-film);
  }
  &.has-state.is-down {
    --state-ink: var(--ifi-danger);
    /* a light film: red text is unreadable on the solid --ifi-danger-fill */
    --state-bg: rgba(207, 19, 34, 0.08);
  }
  /* A filled button in the tier's tint (user's call 2026-11-12): as bare coloured words the state did
     not read as something to press. It keeps its own colour and tint when hovered, a shade deeper,
     where the row's other buttons turn teal. */
  &.has-state:not(:disabled),
  &.has-state:not(:disabled):hover,
  &.has-state:not(:disabled):active {
    color: var(--state-ink) !important;
    background: var(--state-bg) !important;
  }
  &.has-state:not(:disabled):hover {
    filter: brightness(0.95);
  }
  /* Off (nothing to share yet): the same block in antd's disabled grey. The span around it takes the
     pointer, so the tooltip still opens over a disabled button. */
  &.has-state:disabled {
    background: var(--ifi-fill-1);
    pointer-events: none;
  }
  /* The tier's glyph is a 16px lucide icon on a 14px line: set on the text's baseline, as antd sets its
     own 1em icons, it rides two pixels high. Centre it on the button instead. */
  &.has-state .ant-btn-icon {
    display: inline-flex;
    align-items: center;
  }
  &.has-state .ant-btn-icon > svg {
    display: block;
  }
`;

const Panel = styled.div<{ $row?: boolean }>`
  width: ${(p) => (p.$row ? '100%' : '260px')};
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

/* The wide layout (the Share panel): the link and the networks on the left, the QR code beside
   them, so the panel stays within a laptop's height. */
const Wide = styled.div`
  display: flex;
  align-items: stretch;
  gap: 16px;

  .slp-left {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
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

// Reach note: a warning tint for Private (the link won't open for others), muted for Link Only.
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

const QrWrap = styled.div<{ $row?: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding-top: ${(p) => (p.$row ? '0' : '4px')};
  border-top: ${(p) => (p.$row ? 'none' : '1px solid rgba(0, 0, 0, 0.06)')};
`;

const QrCaption = styled.span`
  font-size: 11px;
  color: var(--ifi-text-tertiary, #767676);
`;

const reachHint = (visibility?: Visibility): { text: string; warn: boolean } | null => {
  if (visibility === Visibility.Private) return { text: `Private. ${tierHint('recording', visibility)}`, warn: true };
  if (visibility === Visibility.Unlisted)
    return { text: `Link Only. ${tierHint('recording', visibility)}`, warn: false };
  return null;
};

/** The link, copied to the clipboard; `copied` holds for a moment for the button to say so. */
const useCopyLink = (url: string) => {
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
  return { copied, copy };
};

/**
 * The link and the ways to pass it on: the canonical URL with Copy Link, an optional reach hint,
 * the networks that matter here (LINE / WhatsApp / X / Facebook), and a QR code for the classroom
 * (project it, students scan to the exact page). The Share popover's body, and the Share panel's
 * link section (shareDialog.tsx).
 */
export const ShareLinkPanel = ({
  url,
  title,
  visibility,
  layout = 'column',
}: {
  url: string;
  title: string;
  visibility?: Visibility;
  /** 'row': the QR code beside the link and the networks (the Share panel); 'column': stacked (the popover). */
  layout?: 'column' | 'row';
}) => {
  const { copied, copy } = useCopyLink(url);
  const hint = reachHint(visibility);
  const row = layout === 'row';
  // resetButtonStyle defaults to true (strips native button chrome) so the PlatformRow padding/hover
  // styling applies cleanly — the same reset the old inline-styled share row relied on.
  const shareProps = { url, title } as const;
  const link = (
    <>
      <UrlRow>
        <UrlText title={url}>{url}</UrlText>
        <Tooltip title={copied ? 'Copied' : 'Copy Link'} open={copied || undefined}>
          <Button
            type="text"
            size="small"
            icon={copied ? <CheckOutlined style={{ color: 'var(--ifi-teal)' }} /> : <LinkOutlined />}
            onClick={copy}
            aria-label={copied ? 'Copied' : 'Copy Link'}
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
    </>
  );
  const qr = (
    <QrWrap $row={row}>
      <QRCode value={url} size={row ? 96 : 112} bordered={false} />
      <QrCaption>Scan to open on a phone</QrCaption>
    </QrWrap>
  );
  return (
    <Panel $row={row}>
      {row ? (
        <Wide>
          <div className="slp-left">{link}</div>
          {qr}
        </Wide>
      ) : (
        <>
          {link}
          {qr}
        </>
      )}
    </Panel>
  );
};

/** The button itself: "Share" under the share glyph, or the state's glyph and name. */
const triggerButton = (
  state: ShareState | undefined,
  compact: boolean | undefined,
  opts: { title?: string; disabled?: boolean } = {},
) => (
  <TriggerButton
    type="text"
    className={state ? `has-state${state.open ? ' is-open' : ''}${state.down ? ' is-down' : ''}` : undefined}
    icon={state ? state.icon : <ShareAltOutlined />}
    aria-label={state ? `Share (${state.label})` : 'Share'}
    title={opts.title}
    disabled={opts.disabled}
    style={{ flexShrink: 0 }}
  >
    {compact ? null : state ? state.label : 'Share'}
  </TriggerButton>
);

/**
 * The owner's Share button: the tier's glyph and name in place of "Share" (ShareState), opening the
 * caller's Share panel — a recording's in the analyzer's title row (through ShareMenu), an experiment's
 * in its page's (labProjects/components/ShareButton). The tooltip says what the button is ("Share"; the
 * tier's name too once `compact` leaves the glyph alone) and what the tier means. Without `onClick`
 * the button is off: it still says the state.
 */
export const ShareStateButton = ({
  state,
  compact,
  onClick,
}: {
  state: ShareState;
  compact?: boolean;
  onClick?: () => void;
}) => (
  <Tooltip
    title={
      <>
        <strong>{compact ? `Share · ${state.label}` : 'Share'}</strong> · {state.hint}
      </>
    }
  >
    {/* the span takes the click and the hover: a disabled button gives the tooltip neither */}
    <span onClick={onClick} style={{ display: 'inline-flex' }}>
      {triggerButton(state, compact, { disabled: !onClick })}
    </span>
  </Tooltip>
);

/**
 * One Share affordance replacing the old split of a copy-link icon + a separate row of social icons.
 * A quiet "Share" button opens a popover with the link panel (ShareLinkPanel). On mobile, when the OS
 * share sheet is available, the button calls it directly instead — it carries the full set of the
 * user's own apps (WeChat, LINE, copy, …), a superset of what we could hand-pick. With `onClick`
 * (the owner), the button opens the caller's Share panel instead, where the tiers live too, and
 * `state` makes the button say the tier it stands at (ShareState).
 */
const ShareMenu = ({ url, title, visibility, compact, onClick, state }: Props) => {
  const isMobile = useIsMobile();

  const canNativeShare = isMobile && typeof navigator !== 'undefined' && !!navigator.share;

  const nativeShare = async () => {
    try {
      await navigator.share({ title, url });
    } catch (e) {
      // The user dismissing the OS sheet rejects with AbortError — not an error worth surfacing.
      if ((e as DOMException)?.name !== 'AbortError') console.error('native share failed', e);
    }
  };

  // With a state, the owner's button gets a real tooltip (ShareStateButton). There is no popover on
  // that path for it to get in the way of.
  if (onClick && state) {
    return <ShareStateButton state={state} compact={compact} onClick={onClick} />;
  }

  // Compact: the label moves into a native title tooltip (same affordance as the ⋮ settings button
  // beside it) rather than an antd <Tooltip> — wrapping the trigger in a second overlay component
  // would sit between the Popover and its child and can swallow the popover's trigger events.
  const trigger = triggerButton(state, compact, { title: compact ? 'Share' : undefined });

  if (onClick) {
    return (
      <span onClick={onClick} style={{ display: 'inline-flex' }}>
        {trigger}
      </span>
    );
  }

  if (canNativeShare) {
    return (
      <span onClick={nativeShare} style={{ display: 'inline-flex' }}>
        {trigger}
      </span>
    );
  }

  return (
    <Popover
      content={<ShareLinkPanel url={url} title={title} visibility={visibility} />}
      trigger="click"
      placement="bottomRight"
      destroyTooltipOnHide
    >
      {trigger}
    </Popover>
  );
};

export default ShareMenu;
