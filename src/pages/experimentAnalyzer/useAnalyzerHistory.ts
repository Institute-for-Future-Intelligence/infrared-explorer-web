import { useEffect } from 'react';
import { debounce } from 'lodash';
import useCommonStore, { AnalysisEditSnapshot, analyzerSnapshotSig, buildAnalyzerSnapshot } from '../../stores/common';
import { Experiment } from '../../types';

// A settled continuous gesture (a measuring-area resize or a profile-line drag fires many store writes)
// collapses into ONE undo entry once writes go quiet for this long. A position drag / discrete edit is a
// single write, so it lands as its own entry immediately after the window.
const COALESCE_MS = 300;

/**
 * Ctrl+Z undo / redo for the analyzer's spatial edits (thermometers, T(l) profile lines, annotations).
 *
 * Mirrors useAnalysisPersistence: a single imperative store subscription (outside React render, so the
 * per-frame `value` churn that drives the readouts never re-renders the player) watches the undoable
 * signature and records the state on a trailing debounce. Because undo/redo set the store's history
 * `present` to exactly the snapshot they apply, a restoration reads back as "current sig === present sig"
 * and is never re-recorded — no separate restoring flag needed.
 *
 * `ready` gates the baseline: on a revisit the thermometers reload asynchronously, and capturing before
 * they arrive would misread the load as an edit (same gate useAnalysisPersistence uses). The annotation
 * notes load later still (component state mirrored into the store); their first appearance re-baselines
 * rather than registering as an edit.
 */
export function useAnalyzerHistory(experiment: Experiment, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const expId = experiment.id;
    const store = useCommonStore;

    const snapshot = (state = store.getState()) => buildAnalyzerSnapshot(state, expId);
    // Complete only once every listed thermometer is actually in the map — otherwise the async (re)load
    // filling it, or clearAnalysisCaches emptying it on leave, would look like an edit.
    const isComplete = (s: AnalysisEditSnapshot) => s.thermometers.length === s.thermometersId.length;

    let initialized = false;
    let lastSeenSig = '';
    // Flips true the first time the annotation notes mirror into the store (their async load). That first
    // appearance is a baseline, not an edit; a later change is a genuine edit.
    let annotationsSeen = store.getState().analyzerAnnotations.has(expId);

    const tryInit = (s: AnalysisEditSnapshot): boolean => {
      if (!isComplete(s)) return false;
      store.getState().initAnalyzerHistory(expId, s);
      lastSeenSig = analyzerSnapshotSig(s);
      initialized = true;
      return true;
    };
    tryInit(snapshot());

    // The latest complete snapshot awaiting commit (set on each editing change; folded into history when
    // the debounce fires or is flushed by an undo/redo keypress).
    let latest: AnalysisEditSnapshot | null = null;
    const commit = debounce(() => {
      if (!latest) return;
      store.getState().commitAnalyzerHistory(latest);
      latest = null;
    }, COALESCE_MS);

    const unsubscribe = store.subscribe((state) => {
      const s = snapshot(state);
      if (!isComplete(s)) return; // load filling in, or caches cleared on leave — not an edit
      if (!initialized) {
        tryInit(s);
        return;
      }
      const sig = analyzerSnapshotSig(s);

      // Fold the async annotation initial load into the baseline. MUST run before the sig short-circuit:
      // an initial load of no notes doesn't move the sig, but the flag still has to flip so a later
      // genuine add is treated as an edit rather than another "baseline".
      if (!annotationsSeen && state.analyzerAnnotations.has(expId)) {
        annotationsSeen = true;
        commit.cancel();
        latest = null;
        lastSeenSig = sig;
        store.getState().rebaselineAnalyzerHistory(s);
        return;
      }

      if (sig === lastSeenSig) return; // value-only (per-frame) change or a history-slice-only change
      lastSeenSig = sig;

      // Equal to the committed baseline → this change IS an undo/redo restoration (or a manual return to
      // baseline); don't record it, and drop any pending commit that would re-add the same state.
      const base = state.analyzerHistory.present;
      if (base && sig === analyzerSnapshotSig(base)) {
        commit.cancel();
        latest = null;
        return;
      }

      latest = s;
      commit();
    });

    // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo. Ignored while a text field is focused so
    // inputs keep native text undo (matches the Delete-key guards in profileLine.tsx / annotations.tsx).
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
      if (!isUndo && !isRedo) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      commit.flush(); // fold any in-flight edit into history before stepping through it
      const st = store.getState();
      if (isUndo) st.undoAnalyzer();
      else st.redoAnalyzer();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      commit.cancel();
      unsubscribe();
    };
  }, [experiment.id, ready]);
}
