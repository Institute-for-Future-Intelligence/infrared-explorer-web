/*
 * "Save as…" for someone else's project — a public one's card (Community,
 * the home page's community row) or the shared page's title row: a naming
 * box (the owner's Save as… box, ProjectDialogs RenameProjectDialog), then
 * the server's copy of the whole project under this account (labProjectCopy,
 * api.ts copySharedProject) with that name, and the copy opens at
 * /projects/<id> — as a saved recording opens in the analyzer. A link-only
 * project is copied with the link's token, the `k` the page opened it with.
 * It needs an account, so signed out the shared sign-in prompt comes first
 * (components/signInGate) and the naming box opens by itself once they are in.
 */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { message } from 'antd';
import { useSignInGate } from '../components/signInGate';
import { copySharedProject } from './api';
import { shownTitle } from './core/empty';
import { RenameProjectDialog } from './components/ProjectDialogs';

/** What a save needs of its source: which project, and what the copy is first called after. */
export interface SaveProjectCopyTarget {
  id: string;
  title: string;
}

export function useSaveProjectCopy(): {
  save: (project: SaveProjectCopyTarget, token?: string | null) => void;
  dialog: ReactNode;
} {
  const navigate = useNavigate();
  // the project being saved (and the link's token); null = no box open
  const [target, setTarget] = useState<{ p: SaveProjectCopyTarget; token: string | null } | null>(null);
  const signInGate = useSignInGate({
    title: 'Sign in to save',
    text: 'Saving a copy of this experiment needs an account. Sign in to continue, then name your copy.',
  });

  // rejects into the naming box, which shows the message and stays open
  const saveAs = async (title: string) => {
    if (!target) return;
    try {
      const project = await copySharedProject(target.p.id, target.token, title);
      message.success('Saved as a new experiment.');
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch (e) {
      console.error('failed to save a copy of the project', e);
      // The server's own line when it has one ("This experiment is already one of yours.").
      const text = e instanceof Error && e.message && !/^internal$/i.test(e.message) ? e.message : '';
      throw new Error(text || 'Please try again.');
    }
  };

  const save = (p: SaveProjectCopyTarget, token?: string | null) =>
    signInGate.gate(() => setTarget({ p, token: token ?? null }));

  const dialog = (
    <>
      <RenameProjectDialog
        open={!!target}
        initial={target ? `Copy of ${shownTitle(target.p.title)}` : ''}
        onClose={() => setTarget(null)}
        onRename={saveAs}
        heading="Save as New Experiment"
        okText="Save"
        failTitle="Could not save the experiment"
      />
      {signInGate.dialog}
    </>
  );

  return { save, dialog };
}
