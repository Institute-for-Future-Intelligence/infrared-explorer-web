import { useEffect, useRef, useState } from 'react';
import { Tooltip, Typography } from 'antd';
import { StarFilled } from '@ant-design/icons';
import { Trash2 } from 'lucide-react';
import styled from 'styled-components';
import useCommonStore from '../../../stores/common';
import { renameExperiment } from '../../../services/experiments';
import { Experiment, Visibility } from '../../../types';
import AnalyzerSettingsMenu from './analyzerSettingsMenu';
import ShareMenu, { SHARE_NAME_MIN_PX, type ShareState } from '../../../components/shareMenu';
import ShareDialog from '../../../components/shareDialog';
import { RenamePencil, TitleEditor } from '../../../components/titleRename';
import { revealRenamePencil } from '../../../components/titleRenameReveal';
import { changeVisibility, tierHint, visibilityLabel, VisibilityIcon } from '../../../components/visibilityControl';
import { experimentShareUrl } from '../../../utils/urls';
import { EMBEDDED } from '../../../utils/embedded';

const { Title } = Typography;

// Lay the title and the right-pinned actions (Share + the ⋮ menu) on one row: the title takes the
// available space, the buttons stay pinned to the right.
const TitleWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;

  /* the edit pencil shows while the owner hovers the row */
  ${revealRenamePencil}
`;

// The right-pinned actions (Share + the ⋮ menu), packed tight together — a small gap keeps them
// reading as one toolbar while TitleWrapper's larger gap holds them off the title. The same pair, in
// the same order, ends an experiment's title row (ProjectPage .pp-actions).
const ActionGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
`;

// Display: the title text + a hover-revealed edit pencil sitting just after it.
const HeadingGroup = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;

  /* The title in the page-title face and size, as an experiment's page sets its own (ProjectPage
     .pp-title-row h1), so the two pages' title rows read alike. One 23px line in a row the 32px buttons
     keep 32px tall: the tabs under it do not move. */
  .ant-typography {
    margin: 0;
    min-width: 0;
    font-family: var(--ifi-font-display);
    font-size: 18px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--ifi-ink);
  }
`;

// The glyphs on the owner's Share button (an experiment's page draws its own the same).
const STATE_ICON = { size: 16, strokeWidth: 1.75 } as const;

interface Props {
  experiment: Experiment;
}

/**
 * The experiment's title (`displayName`) shown at the top of the analyzer's info panel.
 * The owner can edit it inline (a hover-revealed pencil, or the ⋮ menu's Rename, opens a single-line
 * editor with explicit Save / Cancel — components/titleRename, which an experiment's page uses too);
 * everyone else sees static text. Edits the human title only — never `name`, which
 * is the internal videostore slug. The owner's row also says how the recording is shared: their
 * Share button reads Private / Link Only / Public (or In Trash) beside the tier's glyph.
 */
const ExperimentTitle = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const editable = !!user && user.id === experiment.ownerId;

  const [editing, setEditing] = useState(false);
  // The owner's Share panel (the tiers and the link); a viewer's Share is the link popover.
  const [sharing, setSharing] = useState(false);
  const setVisibility = async (v: Visibility) => {
    const res = await changeVisibility(experiment.id, v, experiment.featured);
    if (!res) {
      throw new Error('Could not change the sharing.');
    }
    useCommonStore.getState().setExperiment(experiment.id, {
      ...experiment,
      visibility: v,
      featured: res.unfeatured ? false : !!experiment.featured,
    });
  };

  // On narrow panels the Share button sheds its words and goes icon-only (the tooltip carries them
  // instead) — otherwise the fixed-width button squeezes the flexible title down to a few characters
  // long before the panel is truly cramped. The same width as on an experiment's page.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [compactActions, setCompactActions] = useState(false);
  useEffect(() => {
    // Keyed on `editing`: leaving edit mode remounts the display-mode wrapper, so the previous
    // observation targets a dead node and must be re-attached to the fresh one.
    if (editing) return;
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCompactActions(el.clientWidth < SHARE_NAME_MIN_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, [editing]);

  // Close the editor when navigating to another experiment or when this title is renamed elsewhere,
  // so a stale draft never carries over.
  useEffect(() => {
    setEditing(false);
  }, [experiment.id, experiment.displayName]);

  // Confirm the edit: persist a real change (rules-permitted rename service, then patch the cached
  // experiment so the new title shows immediately wherever the store is read — card lists, header,
  // this panel — instead of lagging a navigation behind Firestore, mirroring content.tsx's flush).
  // An empty or unchanged draft writes nothing and just snaps back to the current title. Used by the
  // Save button, Enter, and clicking away (TitleEditor).
  const commit = (next: string) => {
    if (next && next !== experiment.displayName) {
      renameExperiment(experiment.id, next).catch((e) => console.error('failed to rename experiment', e));
      const exp = useCommonStore.getState().experimentMap.get(experiment.id);
      if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, displayName: next });
    }
    setEditing(false);
  };

  // ---- owner, edit mode: single-line input + explicit Save / Cancel ----
  if (editing) {
    return (
      <TitleWrapper>
        <TitleEditor
          initial={experiment.displayName ?? ''}
          placeholder="Recording title"
          onCommit={commit}
          onCancel={() => setEditing(false)}
        />
      </TitleWrapper>
    );
  }

  // How the recording is shared, said by the owner's Share button. A trashed recording (opened from
  // the Trash page) says that instead: it opens for nobody else, whatever tier it carries. A viewer's
  // button, and a legacy doc without a tier, say nothing.
  const { visibility } = experiment;
  const shareState: ShareState | undefined = !editable
    ? undefined
    : experiment.trash
      ? {
          icon: <Trash2 {...STATE_ICON} />,
          label: 'In Trash',
          hint: 'Nobody else can open it until you restore it.',
        }
      : visibility
        ? {
            icon: <VisibilityIcon visibility={visibility} {...STATE_ICON} />,
            label: visibilityLabel(visibility),
            hint: tierHint('recording', visibility),
            open: visibility !== Visibility.Private,
          }
        : undefined;

  // ---- display: the title + (owner) a hover-revealed edit pencil, with the right-pinned actions ----
  return (
    <TitleWrapper ref={wrapperRef}>
      <HeadingGroup>
        {/* A star to the left of the title marks an experiment that's in the homepage showcase (the
            same `featured` flag the ⋮ settings menu toggles, worded the same way as that item and as
            the card grids' badge). Owner-only: it mirrors the toggle the owner controls from the ⋮
            menu, so only they see this status cue — other viewers don't. */}
        {editable && experiment.featured && (
          <Tooltip title="This recording is in the homepage showcase.">
            <StarFilled
              style={{ color: 'var(--ifi-heat)', fontSize: 18, flexShrink: 0 }}
              aria-label="In the homepage showcase"
            />
          </Tooltip>
        )}
        {/* Long recording names ("IR Recording 17:21:11 07/20/2026") would wrap into a tall
            multi-line block on narrow panels — keep the title to one ellipsized line. No hover
            tooltip with the full name: it popped up over the tabs even when nothing was cut off. */}
        <Title level={4} style={{ margin: 0 }} ellipsis>
          {experiment.displayName || 'Untitled recording'}
        </Title>
        {editable && <RenamePencil onClick={() => setEditing(true)} />}
      </HeadingGroup>
      <ActionGroup>
        {/* The owner's Share says how the recording is shared now — the tier's glyph and name
            ("Link Only") in place of "Share", which moves into the tooltip: one control for the
            state and the panel that changes it (user's call 2026-11-12). A chip of its own, beside
            the title or boxed inside this button, read as a second control that opened the same
            panel; "Share · Link Only" said the button's name for nothing. */}
        {/* An embedded window (utils/embedded.ts) has no Share and no ⋮: the title row is the title. */}
        {!EMBEDDED && (
          <ShareMenu
            url={experimentShareUrl(experiment.id)}
            title={experiment.displayName || 'Infrared Explorer'}
            visibility={experiment.visibility}
            compact={compactActions}
            onClick={editable && experiment.visibility ? () => setSharing(true) : undefined}
            state={shareState}
          />
        )}
        {editable && experiment.visibility && (
          <ShareDialog
            open={sharing}
            title="Share Recording"
            kind="recording"
            current={experiment.visibility}
            url={experimentShareUrl(experiment.id)}
            linkTitle={experiment.displayName || 'Infrared Explorer'}
            onVisibility={setVisibility}
            onClose={() => setSharing(false)}
          />
        )}
        {/* Everything else is in the ⋮, as on an experiment's page: Save as… for everyone (it was a
            button of its own here until 2026-11-12), and the owner's Rename · Share… · Move to trash. */}
        <AnalyzerSettingsMenu
          experiment={experiment}
          onRename={editable ? () => setEditing(true) : undefined}
          onShare={editable && experiment.visibility ? () => setSharing(true) : undefined}
        />
      </ActionGroup>
    </TitleWrapper>
  );
};

export default ExperimentTitle;
