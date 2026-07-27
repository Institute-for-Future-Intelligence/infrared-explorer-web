import { Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, Visibility } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import { buildVisibilityMenuItem, changeVisibility } from '../../../components/visibilityControl';
import { changeFeatured } from '../../../components/featureControl';

// A bare ⋮ (no text label) is easy to miss at the light placeholder grey the text buttons beside it
// use, so it gets the darker primary ink, a larger glyph, AND a stroke on the icon's paths to fatten
// the three dots (SVG icons ignore font-weight, so a same-colour stroke is how you embolden them) —
// teal on hover, matching Share / Save as.
const TriggerButton = styled(Button)`
  color: var(--ifi-ink);

  .anticon {
    font-size: 22px;
  }
  .anticon svg {
    stroke: currentColor;
    stroke-width: 48;
  }

  &:not(:disabled):hover {
    color: var(--ifi-teal) !important;
  }
`;

interface Props {
  experiment: Experiment;
}

/**
 * Owner-only overflow (⋮) menu in the analyzer header carrying the experiment's sharing settings:
 *   Visibility — the Private / Link only / Public tier (any owner).
 *   Homepage   — the site-homepage showcase toggle (staff-and-owner; mirrors the Firestore rules).
 * These used to sit as inline controls in the Info tab's facts list; consolidating them into one
 * settings menu beside Share / Save as keeps the facts read-only and puts the owner's "who can see
 * this" decisions in one place. Each change persists itself (with toasts) via the shared
 * change* helpers, then syncs the cached experiment so the menu and any later auto-save agree —
 * both flags move together (demoting below Public un-features; featuring promotes to Public).
 */
const AnalyzerSettingsMenu = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const setExperiment = useCommonStore((state) => state.setExperiment);

  const isOwner = !!user && user.id === experiment.ownerId;
  // Nothing to offer a viewer, or an experiment with no visibility to change — render no trigger.
  if (!isOwner || !experiment.visibility) return null;

  const { id, visibility, featured, ownerId } = experiment;
  const showHomepage = isStaff(user) && ownerId === user.id;

  const setVisibility = async (v: Visibility) => {
    const res = await changeVisibility(id, v, featured);
    if (res) setExperiment(id, { ...experiment, visibility: v, featured: res.unfeatured ? false : !!featured });
  };
  const setHomepage = async (next: boolean) => {
    const res = await changeFeatured(id, next, visibility);
    if (res) setExperiment(id, { ...experiment, featured: next, visibility: res.visibility });
  };

  const items: MenuProps['items'] = [
    buildVisibilityMenuItem(visibility, setVisibility),
    // Staff-only app-homepage showcase toggle, set apart by a divider so it reads as the privileged
    // action. Built inline (not the shared buildFeatureMenuItem) to phrase it "app homepage" here.
    ...(showHomepage
      ? [
          { type: 'divider' as const },
          {
            key: 'feature',
            icon: featured ? <StarFilled style={{ color: 'var(--ifi-heat)' }} /> : <StarOutlined />,
            label: featured ? 'Remove from app homepage' : 'Add to app homepage',
            onClick: () => setHomepage(!featured),
          },
        ]
      : []),
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
      <TriggerButton
        type="text"
        icon={<MoreOutlined />}
        aria-label="Experiment settings"
        title="Settings"
        style={{ flexShrink: 0 }}
      />
    </Dropdown>
  );
};

export default AnalyzerSettingsMenu;
