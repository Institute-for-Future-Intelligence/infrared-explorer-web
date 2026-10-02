import { SetStateAction, useEffect, useState } from 'react';
import { readViewerPref, writeViewerPref } from '../../../utils/viewerPrefs';
import type { Surface3DView } from './thermalSurface3D';

interface Surface3DState {
  open: boolean;
  view: Surface3DView;
}

const CLOSED: Surface3DState = { open: false, view: 'modal' };

/**
 * The toolbar's 3D-surface toggle for one experiment: whether the surface is up, and in which
 * presentation (full window or miniplayer — sticky, so a closed miniplayer reopens as one). Remembered in
 * this browser per experiment (viewerPrefs), so a reload or a return visit finds it as it was left.
 * Per viewer, never on the experiment: a surface left open must not pop up over the page for everyone
 * else who opens it. The default (closed, full window) is stored as no key at all.
 */
export const useSurface3DState = (expId: string) => {
  const key = `surface3d.${expId}`;
  const [state, setState] = useState<Surface3DState>(() => {
    const saved = readViewerPref<Partial<Surface3DState> | null>(key, null);
    return { open: saved?.open === true, view: saved?.view === 'window' ? 'window' : 'modal' };
  });

  useEffect(() => {
    writeViewerPref(key, state.open || state.view !== CLOSED.view ? state : undefined);
  }, [key, state]);

  const setOpen = (next: SetStateAction<boolean>) =>
    setState((s) => ({ ...s, open: typeof next === 'function' ? next(s.open) : next }));
  const setView = (view: Surface3DView) => setState((s) => ({ ...s, view }));
  return { open: state.open, view: state.view, setOpen, setView };
};
