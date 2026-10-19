/*
 * "Save to My Experiments" for someone else's project — a public one's card
 * (the app's useProjectCardMenu saveCopy) or the shared page's title row: the
 * server's copy of the whole project under this account (labProjectCopy,
 * api.ts copySharedProject), then the copy opens at /projects/<id> — as a
 * saved recording opens in the analyzer. A link-only project is copied with
 * the link's token, the `k` the page opened it with. It needs an account, so
 * signed out the shared sign-in prompt comes first (components/signInGate)
 * and the save runs by itself once they are in.
 */

import { useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { message } from 'antd';
import { useSignInGate } from '../components/signInGate';
import { copySharedProject } from './api';
import { shownTitle } from './core/empty';

/** What a save needs of its source: which project, and what to call it while it is on its way. */
export interface SaveProjectCopyTarget {
  id: string;
  title: string;
}

export function useSaveProjectCopy(): {
  save: (project: SaveProjectCopyTarget, token?: string | null) => void;
  dialog: ReactNode;
} {
  const navigate = useNavigate();
  // one copy at a time: a second click while the first is on its way does nothing
  const saving = useRef(false);
  const signInGate = useSignInGate({
    title: 'Sign in to save',
    text: 'Saving a copy of this experiment to My Experiments needs an account. Sign in to continue.',
  });

  const perform = async (p: SaveProjectCopyTarget, token?: string | null) => {
    if (saving.current) return;
    saving.current = true;
    const hide = message.loading(`Saving "${shownTitle(p.title)}" to My Experiments…`, 0);
    try {
      const project = await copySharedProject(p.id, token);
      hide();
      message.success('Saved to My Experiments.');
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch (e) {
      hide();
      console.error('failed to save a copy of the project', e);
      // The server's own line when it has one ("This experiment is already one of yours.").
      const text = e instanceof Error && e.message && !/^internal$/i.test(e.message) ? e.message : '';
      message.error(text || 'Could not save this experiment. Please try again.');
    } finally {
      saving.current = false;
    }
  };

  const save = (p: SaveProjectCopyTarget, token?: string | null) => signInGate.gate(() => void perform(p, token));

  return { save, dialog: signInGate.dialog };
}
