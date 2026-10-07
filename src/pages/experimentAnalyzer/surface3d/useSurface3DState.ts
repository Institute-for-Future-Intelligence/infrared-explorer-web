import { SetStateAction, useEffect, useRef, useState } from 'react';
import type { Experiment } from '../../../types';
import { useSavedViewWriter } from '../useSavedViewWriter';
import type { Surface3DView } from './thermalSurface3D';

interface Surface3DState {
  open: boolean;
  view: Surface3DView;
}

/**
 * The toolbar's 3D-surface toggle for one experiment: whether the surface is up, and in which
 * presentation (full window or miniplayer — sticky, so a closed miniplayer reopens as one). Part of the
 * experiment's saved view (ExperimentDoc.savedView.surface3d, see useSavedViewWriter): the owner leaves
 * the surface up, and everyone — the owner back on a return visit, a viewer, a copy — opens the
 * experiment with it up, the same way the saved charts and overlays are everyone's. A non-owner's toggle
 * lasts the visit only. The default (closed, full window) is what an absent field means.
 */
export const useSurface3DState = (experiment: Experiment) => {
  const [state, setState] = useState<Surface3DState>(() => {
    const saved = experiment.savedView?.surface3d;
    return { open: saved?.open === true, view: saved?.view === 'window' ? 'window' : 'modal' };
  });
  const write = useSavedViewWriter(experiment);

  // Write each change, not the opening state (that's what the doc already says). Compared against the
  // last state handed to the writer rather than gated on a first run, so a re-run of the effect with the
  // same state (StrictMode's double mount) writes nothing either.
  const lastRef = useRef(state);
  useEffect(() => {
    if (state.open === lastRef.current.open && state.view === lastRef.current.view) return;
    lastRef.current = state;
    write({ surface3d: state });
  }, [write, state]);

  const setOpen = (next: SetStateAction<boolean>) =>
    setState((s) => ({ ...s, open: typeof next === 'function' ? next(s.open) : next }));
  const setView = (view: Surface3DView) => setState((s) => ({ ...s, view }));
  return { open: state.open, view: state.view, setOpen, setView };
};
