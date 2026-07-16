import { useState } from 'react';
import { Button, Tooltip, message } from 'antd';
import { CheckOutlined, LinkOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment } from '../../../types';

interface Props {
  experiment: Experiment;
}

// Quiet grey by default, teal on hover — matches SaveToMyExperiments beside it so the two icon
// actions read as one restrained toolbar rather than competing with the title.
const LinkButton = styled(Button)`
  color: var(--ifi-grey);

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
`;

/** The shareable, in-app URL for this experiment. HashRouter, so the id lives after the `#`. */
const experimentUrl = (id: string) => `${window.location.origin}/#/experiments/${id}`;

/**
 * Copies this experiment's link to the clipboard. Visible to everyone (a link is shareable whether
 * or not you're signed in). Briefly swaps to a check + "Copied" tooltip as confirmation.
 */
const CopyLink = ({ experiment }: Props) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const url = experimentUrl(experiment.id);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      // Revert the icon/tooltip after a beat so the affordance is reusable.
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('failed to copy experiment link', e);
      message.error('Could not copy the link.');
    }
  };

  const label = copied ? 'Copied' : 'Copy link';

  return (
    <Tooltip title={label} open={copied || undefined}>
      <LinkButton
        type="text"
        icon={copied ? <CheckOutlined style={{ color: 'var(--ifi-teal)' }} /> : <LinkOutlined />}
        onClick={handleCopy}
        aria-label={label}
        style={{ flexShrink: 0 }}
      />
    </Tooltip>
  );
};

export default CopyLink;
