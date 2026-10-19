/*
 * The owner's Share panel for an AI experiment, as the app's
 * ShareProjectDialog: the Share panel every kind uses (components/
 * shareDialog — the tiers, the link, the Terms record) with what an
 * experiment adds: what staff did to it, and what viewers get. Captures are
 * not uploaded from here — the website has none of its own yet; the app's
 * upload while it is shared.
 */

import { Visibility } from '../../types';
import SharePanel from '../../components/shareDialog';
import type { Project, ShareVisibility } from '../core/types';
import { shownTitle } from '../core/empty';
import { TAKEN_DOWN } from '../shareTiers';

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
  const current = (project.share?.visibility ?? 'private') as Visibility;
  const takenDown = project.share?.takenDown === true;
  return (
    <SharePanel
      open={open}
      title="Share Experiment"
      kind="experiment"
      current={current}
      url={project.share?.url ?? null}
      linkTitle={shownTitle(project.title)}
      blocked={takenDown ? { [Visibility.Public]: TAKEN_DOWN } : undefined}
      onVisibility={(v) => onVisibility(v as ShareVisibility)}
      onClose={onClose}
      note="Viewers see the conversation, the plan, the report and the captures the app has uploaded. A capture still on the phone shows as not shared until it is uploaded from the app."
    />
  );
};

export default ShareDialog;
