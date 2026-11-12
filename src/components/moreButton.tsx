import { Button } from 'antd';
import { EllipsisVertical } from 'lucide-react';
import styled from 'styled-components';

/**
 * The ⋮ that ends a page's title row and opens its menu: a recording's in the analyzer
 * (analyzerSettingsMenu) and an experiment's on its page (labProjects ProjectMenu, and the visitor's
 * Save as… menu in ProjectPage) — one button, so the two rows end alike. Drawn in the title's ink: a
 * bare glyph at the grey of the text buttons beside it is easy to miss. Teal on hover, as the Share
 * button to its left.
 */
const MoreButton = styled(Button).attrs({
  type: 'text' as const,
  icon: <EllipsisVertical size={18} aria-hidden />,
})`
  flex-shrink: 0;
  color: var(--ifi-ink);

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
  /* the glyph centred on the button, not set on the text's baseline (as shareMenu's does its own) */
  .ant-btn-icon {
    display: inline-flex;
    align-items: center;
  }
  .ant-btn-icon > svg {
    display: block;
  }
`;

export default MoreButton;
