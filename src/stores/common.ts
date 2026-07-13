import { enableMapSet, produce } from 'immer';
import { create } from 'zustand';
import {
  Annotation,
  QaModel,
  QaMoment,
  TComment,
  Experiment,
  TemperatureUnit,
  Thermometer,
  User,
  DEFAULT_MODEL,
  isModelKey,
} from '../types';

enableMapSet();

// Restore the last-picked Q&A model from localStorage (default model); mirrors the panel's persistence.
// A value saved under a now-removed key (e.g. an old Claude pick) fails isModelKey and falls back.
const readInitialQaModel = (): QaModel => {
  try {
    const saved = localStorage.getItem('qa-model');
    return isModelKey(saved) ? saved : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
};

interface CommonStoreState {
  setStore: (fn: (state: CommonStoreState) => void) => void;
  user: User | null;
  setUser: (user: User | null) => void;

  // Left navigation sidebar collapse state (icon-rail when true). Toggled by the header hamburger on
  // desktop (>768px). On mobile the sidebar is an off-canvas drawer instead, driven by mobileDrawerOpen.
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // Mobile (<=768px) off-canvas drawer visibility. On phones the sidebar overlays the content instead
  // of occupying flex space; the header hamburger toggles this, and tapping a nav item / the backdrop
  // closes it. Defaults closed so the content is visible on first load.
  mobileDrawerOpen: boolean;
  toggleMobileDrawer: () => void;
  setMobileDrawerOpen: (open: boolean) => void;

  // Home-page search, lifted into the store so the search box can live in the global header (shown on
  // the home page only) while the grid that consumes the term stays in HomePage.
  homeSearchTerm: string;
  setHomeSearchTerm: (term: string) => void;
  // Lightweight {id,label} suggestions HomePage publishes for the header search's autocomplete.
  homeSearchItems: { id: string; label: string }[];
  setHomeSearchItems: (items: { id: string; label: string }[]) => void;

  // only cache thumbnail for now
  imageCache: Map<string, string | ArrayBuffer>;
  setImageCache: (url: string, res: string | ArrayBuffer) => void;

  showcaseThermalCache: Map<string, ArrayBuffer[]>;
  setShowcaseThermalCache: (id: string, data: ArrayBuffer[]) => void;

  experimentMap: Map<string, Experiment>;
  setExperiment: (id: string, experiment: Experiment) => void;

  thermometerMap: Map<string, Thermometer>;
  setThermometer: (id: string, thermometer: Thermometer) => void;
  updateThermometer: (id: string, fields: Partial<Thermometer>) => void;
  // Add a new thermometer and register its id on the experiment (in-memory; persisted on "Save analysis").
  addThermometer: (expId: string, thermometer: Thermometer) => void;
  // Remove one / all thermometers from an experiment (also clears the selection when affected).
  removeThermometer: (expId: string, id: string) => void;
  removeAllThermometers: (expId: string) => void;

  // The currently selected thermometer (drives selected-colour + context-menu delete). null = none.
  selectedThermometerId: string | null;
  selectThermometer: (id: string | null) => void;

  // The thermometer currently hovered (in the image). Highlights its series in the charts and
  // dims the others. null = none hovered.
  hoveredThermometerId: string | null;
  hoverThermometer: (id: string | null) => void;

  // ---- AI analyzer bridges (analyzer; recording experiments only) ----
  // Q&A panel / moment-chip -> player: seek to a player-frame index. The nonce makes a repeat request
  // for the same frame still fire.
  keyframeSeek: { playerIndex: number; nonce: number } | null;
  requestKeyframeSeek: (playerIndex: number) => void;

  // ---- AI Q&A (analyzer Q&A panel; recording experiments only) ----
  // Moments the user has attached to their next question (frozen frame snapshots), capped at 3, kept in
  // the store (not the panel) so they survive tab switches / a right-click "ask" while the panel is
  // unmounted. Sorted by tSeconds; deduped by recordingIndex. Cleared on leaving the analyzer.
  attachedMoments: QaMoment[];
  addAttachedMoment: (moment: QaMoment) => void;
  removeAttachedMoment: (recordingIndex: number) => void;
  clearAttachedMoments: () => void;

  // Q&A panel -> player: snapshot the current playhead as a moment (the player owns the frame index,
  // the on-screen image, and the live probe readings, so only it can build the snapshot). The nonce
  // makes a repeat request fire again.
  snapshotMomentRequest: { nonce: number } | null;
  requestSnapshotMoment: () => void;

  // Selected Q&A model (see MODEL_KEYS). Lifted into the store — not just the Q&A panel's local state —
  // so the player's right-click menu can reactively disable moment-attach when the model is text-only
  // (see isTextOnlyModel). Persisted to localStorage ('qa-model') across reloads.
  qaModel: QaModel;
  setQaModel: (model: QaModel) => void;

  // Player -> InfoSection: switch to the Analysis tab (e.g. after a right-click "Ask about this moment"
  // so the freshly attached chip is visible). The nonce makes a repeat request fire again.
  openAnalysisTabRequest: { nonce: number } | null;
  requestOpenAnalysisTab: () => void;

  commentMap: Map<string, TComment>;
  setComment: (id: string, comment: TComment) => void;

  // Live annotations for the experiment open in the analyzer, mirrored here from <Annotations>
  // (whose notes are local component state, not otherwise in this store). Lets a clone — "Save to My
  // Experiments" / "Save clip" — capture the viewer's local sandbox annotation edits, which the
  // Firestore source lacks. Keyed by expId; cleared with the other caches on leaving the analyzer.
  analyzerAnnotations: Map<string, Annotation[]>;
  setAnalyzerAnnotations: (expId: string, annotations: Annotation[]) => void;

  // Clear the per-experiment caches (thermometers + comments + annotations) when leaving the
  // analyzer, so a later clip doesn't accumulate another clip's entries.
  clearAnalysisCaches: () => void;

  // Global temperature display unit (raw readings are Celsius; converted at display time).
  temperatureUnit: TemperatureUnit;
  toggleTemperatureUnit: () => void;
}

const useCommonStore = create<CommonStoreState>()((set, get) => {
  const immerSet: CommonStoreState['setStore'] = (fn) => set(produce(fn));

  return {
    setStore: immerSet,
    user: null,
    setUser(user: User | null) {
      immerSet((state) => {
        state.user = user;
      });
    },

    sidebarCollapsed: false,
    toggleSidebar() {
      immerSet((state) => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
      });
    },
    setSidebarCollapsed(collapsed) {
      immerSet((state) => {
        state.sidebarCollapsed = collapsed;
      });
    },

    mobileDrawerOpen: false,
    toggleMobileDrawer() {
      immerSet((state) => {
        state.mobileDrawerOpen = !state.mobileDrawerOpen;
      });
    },
    setMobileDrawerOpen(open) {
      immerSet((state) => {
        state.mobileDrawerOpen = open;
      });
    },

    homeSearchTerm: '',
    setHomeSearchTerm(term) {
      immerSet((state) => {
        state.homeSearchTerm = term;
      });
    },
    homeSearchItems: [],
    setHomeSearchItems(items) {
      immerSet((state) => {
        state.homeSearchItems = items;
      });
    },

    imageCache: new Map(),
    setImageCache(url, res) {
      immerSet((state) => {
        state.imageCache.set(url, res);
      });
    },

    showcaseThermalCache: new Map(),
    setShowcaseThermalCache(id, data) {
      immerSet((state) => {
        state.showcaseThermalCache.set(id, data);
      });
    },

    experimentMap: new Map(),
    setExperiment(id, experiment) {
      immerSet((state) => {
        state.experimentMap.set(id, experiment);
      });
    },
    thermometerMap: new Map(),
    setThermometer(id, thermometer) {
      immerSet((state) => {
        state.thermometerMap.set(id, thermometer);
      });
    },
    updateThermometer(id, fields) {
      immerSet((state) => {
        const t = state.thermometerMap.get(id);
        if (t) state.thermometerMap.set(id, { ...t, ...fields });
      });
    },
    addThermometer(expId, thermometer) {
      immerSet((state) => {
        state.thermometerMap.set(thermometer.id, thermometer);
        const experiment = state.experimentMap.get(expId);
        if (experiment) {
          const ids = experiment.thermometersId ?? [];
          if (!ids.includes(thermometer.id)) {
            state.experimentMap.set(expId, { ...experiment, thermometersId: [...ids, thermometer.id] });
          }
        }
      });
    },
    removeThermometer(expId, id) {
      immerSet((state) => {
        state.thermometerMap.delete(id);
        const experiment = state.experimentMap.get(expId);
        if (experiment) {
          state.experimentMap.set(expId, {
            ...experiment,
            thermometersId: (experiment.thermometersId ?? []).filter((t) => t !== id),
          });
        }
        if (state.selectedThermometerId === id) state.selectedThermometerId = null;
        if (state.hoveredThermometerId === id) state.hoveredThermometerId = null;
      });
    },
    removeAllThermometers(expId) {
      immerSet((state) => {
        const experiment = state.experimentMap.get(expId);
        (experiment?.thermometersId ?? []).forEach((id) => state.thermometerMap.delete(id));
        if (experiment) {
          state.experimentMap.set(expId, { ...experiment, thermometersId: [] });
        }
        state.selectedThermometerId = null;
        state.hoveredThermometerId = null;
      });
    },
    selectedThermometerId: null,
    selectThermometer(id) {
      immerSet((state) => {
        state.selectedThermometerId = id;
      });
    },
    hoveredThermometerId: null,
    hoverThermometer(id) {
      immerSet((state) => {
        state.hoveredThermometerId = id;
      });
    },

    keyframeSeek: null,
    requestKeyframeSeek(playerIndex) {
      immerSet((state) => {
        state.keyframeSeek = { playerIndex, nonce: (state.keyframeSeek?.nonce ?? 0) + 1 };
      });
    },

    attachedMoments: [],
    addAttachedMoment(moment) {
      immerSet((state) => {
        // Dedupe by frame (re-attaching the same frame replaces it), cap at 3, keep time-ordered.
        const rest = state.attachedMoments.filter((m) => m.recordingIndex !== moment.recordingIndex);
        if (rest.length >= 3) return; // already at the cap with distinct frames — ignore the new one
        state.attachedMoments = [...rest, moment].sort((a, b) => a.tSeconds - b.tSeconds);
      });
    },
    removeAttachedMoment(recordingIndex) {
      immerSet((state) => {
        state.attachedMoments = state.attachedMoments.filter((m) => m.recordingIndex !== recordingIndex);
      });
    },
    clearAttachedMoments() {
      immerSet((state) => {
        state.attachedMoments = [];
      });
    },
    snapshotMomentRequest: null,
    requestSnapshotMoment() {
      immerSet((state) => {
        state.snapshotMomentRequest = { nonce: (state.snapshotMomentRequest?.nonce ?? 0) + 1 };
      });
    },
    qaModel: readInitialQaModel(),
    setQaModel(model) {
      immerSet((state) => {
        state.qaModel = model;
      });
      try {
        localStorage.setItem('qa-model', model);
      } catch {
        // Ignore storage failures (private mode / quota) — the in-memory value still drives the UI.
      }
    },
    openAnalysisTabRequest: null,
    requestOpenAnalysisTab() {
      immerSet((state) => {
        state.openAnalysisTabRequest = { nonce: (state.openAnalysisTabRequest?.nonce ?? 0) + 1 };
      });
    },

    commentMap: new Map(),
    setComment(id, comment) {
      immerSet((state) => {
        state.commentMap.set(id, comment);
      });
    },
    analyzerAnnotations: new Map(),
    setAnalyzerAnnotations(expId, annotations) {
      immerSet((state) => {
        state.analyzerAnnotations.set(expId, annotations);
      });
    },
    clearAnalysisCaches() {
      immerSet((state) => {
        state.thermometerMap.clear();
        state.commentMap.clear();
        state.analyzerAnnotations.clear();
        state.keyframeSeek = null;
        state.attachedMoments = [];
        state.snapshotMomentRequest = null;
        state.openAnalysisTabRequest = null;
      });
    },
    temperatureUnit: TemperatureUnit.celsius,
    toggleTemperatureUnit() {
      immerSet((state) => {
        state.temperatureUnit =
          state.temperatureUnit === TemperatureUnit.celsius ? TemperatureUnit.fahrenheit : TemperatureUnit.celsius;
      });
    },
  };
});

export default useCommonStore;
