import { useEffect, useState } from 'react';
import { debounce } from 'lodash';
import useCommonStore from '../../stores/common';
import { saveAnalysis } from '../../services/experiments';
import { Experiment, Thermometer, User } from '../../types';

interface Options {
  /**
   * Video sources re-derive their thermometers from the .wrk preset on load; pass true so the owner's
   * save flags the doc (`customThermometers`) to read the saved subcollection instead. Recordings always
   * read the subcollection, so they leave this false.
   */
  markCustomThermometers?: boolean;
}

/**
 * Shared analysis persistence for both players (ImagePlayer / VideoPlayer).
 *
 * For the OWNER: auto-persist analysis edits (thermometer placement / measuring area + graph options),
 * debounced so a drag or burst of toggles collapses to one write, and flushed on leave. We subscribe to
 * the store imperatively (outside React render) so the per-frame `value` updates that drive the readout
 * don't re-render the player; the save signature deliberately excludes `value`. Thermometers removed
 * in-memory are diffed against the previous id set and reconciled away from Firestore (otherwise a
 * deleted thermometer reappears on reload).
 *
 * For EVERYONE ELSE (non-owner, signed-out): the analyzer is a local sandbox — their thermometer and
 * annotation edits are never written to the source. We watch for the first real edit (a thermometer
 * moved/added/removed/renamed/re-measured, or an annotation added/moved/edited/removed) and return a
 * `sandboxDirty` flag so the workspace can invite them to save a personal copy (a clone carries these
 * exact placements + notes). Graph-option toggles don't set it: the clone re-derives graphs from source.
 *
 * `ready` gates the baseline capture: on a revisit the experiment is served from the cached
 * experimentMap while its thermometers (cleared on leaving) reload asynchronously. Capturing the
 * baseline before they arrive would misread the reload as a user edit — bumping `updatedAt` (owner) or
 * raising a false sandbox banner (viewer). Pass true only once the store reflects the saved analysis
 * (nothing to load, or every thermometer present).
 */
export function useAnalysisPersistence(experiment: Experiment, ready: boolean, options: Options = {}): boolean {
  const user = useCommonStore((state) => state.user);
  const markCustom = options.markCustomThermometers ?? false;
  const [sandboxDirty, setSandboxDirty] = useState(false);

  // Each experiment starts clean. The players are keyed by id (so a fresh mount already resets this),
  // but reset explicitly too: the effect below also re-runs on a mid-session sign-in / visibility
  // change, and this keeps a stale flag from surviving that.
  useEffect(() => {
    setSandboxDirty(false);
  }, [experiment.id]);

  useEffect(() => {
    if (!ready) return;
    const currentUser = user;
    const isOwner = !!currentUser && currentUser.id === experiment.ownerId;

    const sigOf = (t: Thermometer) => [
      t.id,
      t.name ?? null,
      t.x,
      t.y,
      t.unit,
      t.measuringAreaType ?? null,
      t.measuringAreaWidth ?? null,
      t.measuringAreaHeight ?? null,
    ];
    const snapshot = (state = useCommonStore.getState()) => {
      const exp = state.experimentMap.get(experiment.id);
      const ids = exp?.thermometersId ?? [];
      const thermometers = ids.map((id) => state.thermometerMap.get(id)).filter(Boolean) as Thermometer[];
      return { ids, thermometers, graphsOptions: exp?.graphsOptions ?? [] };
    };
    const thermoSig = (s: ReturnType<typeof snapshot>) => JSON.stringify(s.thermometers.map(sigOf));
    const saveSig = (s: ReturnType<typeof snapshot>) => JSON.stringify({ g: s.graphsOptions, t: thermoSig(s) });

    // Annotation edits also count as sandbox work — a clone carries the viewer's local notes too. They
    // live in analyzerAnnotations, populated only AFTER <Annotations> finishes its initial load (its
    // loadedRef gate), so `null` here means "not loaded yet": the first non-null value is the baseline
    // and only a later change to it is a real edit. Owners persist notes immediately (annotations.tsx),
    // so this drives the non-owner banner only.
    const annoSig = (state = useCommonStore.getState()) => {
      if (!state.analyzerAnnotations.has(experiment.id)) return null;
      const items = state.analyzerAnnotations.get(experiment.id) ?? [];
      return JSON.stringify(
        items.map((a) => [
          a.id,
          a.x,
          a.y,
          a.dx ?? null,
          a.dy ?? null,
          a.note ?? '',
          a.time?.start ?? null,
          a.time?.end ?? null,
        ]),
      );
    };

    // A snapshot is "complete" only when every thermometer the clip lists (thermometersId) is actually
    // present in the store. It goes incomplete two ways, neither a user edit: the async (re)load filling
    // the map, and clearAnalysisCaches() emptying thermometerMap when the analyzer unmounts while
    // thermometersId still lists them. A user add/delete always keeps the two in sync, so acting on an
    // incomplete snapshot would bump updatedAt on a mere view (owner) or raise a false banner (viewer).
    const isComplete = (s: ReturnType<typeof snapshot>) => s.thermometers.length === s.ids.length;

    const initial = snapshot();
    let prevIds = new Set(initial.ids);
    let prevSaveSig = saveSig(initial);
    let prevThermoSig = thermoSig(initial);
    let lastComplete = initial; // baseline is complete — the effect is gated on `ready`
    const pendingDeletes = new Set<string>();
    let annoBaseline = annoSig(); // null until <Annotations> mirrors its loaded notes into the store
    // immer swaps analyzerAnnotations' reference only when a note actually changes, so a plain identity
    // check skips the per-frame stringify during playback (value-only store churn keeps the same map).
    let prevAnnoMap = useCommonStore.getState().analyzerAnnotations;
    let dirtyFired = false;
    const markSandboxDirty = () => {
      if (dirtyFired) return; // once flagged, stop checking — the banner is already up
      dirtyFired = true;
      setSandboxDirty(true);
    };

    const scheduleSave = debounce(() => {
      const s = lastComplete;
      if (!isComplete(s)) return; // nothing valid to persist (never reached once complete, but be safe)
      const deleted = [...pendingDeletes];
      pendingDeletes.clear();
      // Read the tier at save time, NOT from this effect's closure: the owner can change visibility
      // (the Description panel's picker) while an edit is pending, and the cleanup flush below would
      // otherwise stamp every thermometer sub-doc with the stale pre-change tier — silently undoing the
      // mirror updateVisibility() just wrote.
      const visibility =
        useCommonStore.getState().experimentMap.get(experiment.id)?.visibility ?? experiment.visibility;
      saveAnalysis(experiment.id, currentUser as User, s.thermometers, s.graphsOptions, visibility, deleted, {
        markCustomThermometers: markCustom,
      }).catch((e) => console.error('failed to auto-save analysis', e));
    }, 800);

    const unsubscribe = useCommonStore.subscribe((state) => {
      // Annotation edits (non-owner banner only). Checked first: an annotation-only change doesn't move
      // the thermometer signature that gates the early-return below, so it must not sit behind it.
      if (!isOwner && !dirtyFired && state.analyzerAnnotations !== prevAnnoMap) {
        prevAnnoMap = state.analyzerAnnotations;
        const currAnno = annoSig(state);
        if (currAnno !== null) {
          if (annoBaseline === null)
            annoBaseline = currAnno; // notes just loaded — baseline, not an edit
          else if (currAnno !== annoBaseline) markSandboxDirty();
        }
      }

      const s = snapshot(state);
      const sig = saveSig(s);
      if (sig === prevSaveSig) return; // value-only (per-frame) change — nothing persistable moved
      if (!isComplete(s)) return; // load still filling in, or caches cleared on leave — not an edit
      const nextIds = new Set(s.ids);
      prevIds.forEach((id) => !nextIds.has(id) && pendingDeletes.add(id));
      prevIds = nextIds;
      const tSig = thermoSig(s);
      const thermometersMoved = tSig !== prevThermoSig;
      prevSaveSig = sig;
      prevThermoSig = tSig;
      lastComplete = s; // the debounced save (incl. flush-on-leave) persists this, not a live re-read
      if (isOwner) scheduleSave();
      else if (thermometersMoved) markSandboxDirty();
    });

    return () => {
      unsubscribe();
      if (isOwner) scheduleSave.flush(); // persist a just-made edit before leaving (no-op if nothing pending)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, experiment.id, experiment.ownerId, experiment.visibility, ready, markCustom]);

  return sandboxDirty;
}
