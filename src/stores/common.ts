import { enableMapSet, produce } from 'immer';
import { create } from 'zustand';
import {
  Annotation,
  QaModel,
  QaMoment,
  KeyMoment,
  TComment,
  Experiment,
  TemperatureUnit,
  Thermometer,
  User,
  DEFAULT_MODEL,
  isModelKey,
} from '../types';

enableMapSet();

// Which panel fills the analyzer's right-hand workspace column (see workspaceMode). 'info' is the
// experiment's description + facts (the default view); 'charts' is the live-coupled plots.
export type WorkspaceMode = 'info' | 'charts' | 'askAI' | 'aiReport';

// What a player snapshot request is for: a Q&A moment attachment (staff, capped at 3), a single-frame
// key moment the owner marks, the start / end of a key-moment SPAN (two-step: mark the start, play to the
// end, mark the end), or re-anchoring an existing key moment's start ('reanchor') or span end
// ('reanchorEnd') to the current frame (its `target` is the moment's recordingIndex). The player builds
// the same frame snapshot; only gate + destination differ.
export type SnapshotPurpose = 'qa' | 'keyMoment' | 'spanStart' | 'spanEnd' | 'reanchor' | 'reanchorEnd';

// Ceiling on owner-marked key moments per experiment (enough to chapter a clip without turning the strip
// into a wall of chips). Enforced in addKeyMoment and re-checked by the player before it snapshots.
export const MAX_KEY_MOMENTS = 12;

// telelab-style chart display options, hoisted here so they persist across chart unmounts (a workspace
// mode switch) instead of resetting to defaults each time the charts remount.
export interface LineChartSettings {
  lineWidth: number;
  symbolCount: number;
  symbolSize: number;
  horizontalGrid: boolean;
  verticalGrid: boolean;
}
export interface ScatterChartSettings {
  lineWidth: number;
  errorBars: boolean;
  horizontalGrid: boolean;
  verticalGrid: boolean;
}

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
  // True once the auth listener has resolved the initial session (signed in OR out). Pages whose
  // layout depends on "is this me?" (the profile page) wait for it instead of flashing the
  // signed-out view during the async session restore.
  authReady: boolean;
  setAuthReady: (ready: boolean) => void;

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

  // Key-moment span -> player: seek to the start frame, play, and pause at the end frame (both in
  // player-frame space). The nonce makes a repeat request for the same span still fire.
  playSpanRequest: { startPlayerIndex: number; endPlayerIndex: number; nonce: number } | null;
  requestPlaySpan: (startPlayerIndex: number, endPlayerIndex: number) => void;

  // Key-moment play button -> player: pause playback. The nonce makes a repeat request still fire.
  pauseRequest: { nonce: number } | null;
  requestPause: () => void;

  // Whether the analyzer player is currently playing (mirrored from the player) + which span (by its
  // recordingIndex) the key-moment strip last started, so that span's button can show pause and toggle.
  // Setting playerPlaying false clears activeSpanStart (playback ended / was paused / seeked away).
  playerPlaying: boolean;
  activeSpanStart: number | null;
  setPlayerPlaying: (playing: boolean) => void;
  setActiveSpanStart: (recordingIndex: number | null) => void;

  // The mounted player's frame timing, published by the player so UI (the key-moment time editor) can
  // convert a typed time to a player-frame index without a round-trip: secondsPerFrame = seconds per
  // player frame (1/FPS for a recording, videoDuration/frameCount for a video); lastFrame = max index.
  playerFrameRate: { secondsPerFrame: number; lastFrame: number } | null;
  setPlayerFrameRate: (rate: { secondsPerFrame: number; lastFrame: number } | null) => void;

  // ---- AI Q&A (analyzer Q&A panel; recording experiments only) ----
  // Moments the user has attached to their next question (frozen frame snapshots), capped at 3, kept in
  // the store (not the panel) so they survive tab switches / a right-click "ask" while the panel is
  // unmounted. Sorted by tSeconds; deduped by recordingIndex. Cleared on leaving the analyzer.
  attachedMoments: QaMoment[];
  addAttachedMoment: (moment: QaMoment) => void;
  removeAttachedMoment: (recordingIndex: number) => void;
  clearAttachedMoments: () => void;

  // Q&A panel / key-moment bar -> player: snapshot the current playhead (the player owns the frame
  // index, the on-screen image, and the live probe readings, so only it can build the snapshot). The
  // purpose routes it to the Q&A attachments or the key-moment chapters; the nonce makes a repeat fire.
  // `target` (a moment's recordingIndex) is set only for a 'reanchor' request.
  snapshotMomentRequest: { nonce: number; purpose: SnapshotPurpose; target?: number } | null;
  requestSnapshotMoment: (purpose?: SnapshotPurpose, target?: number) => void;

  // Owner-marked key moments for the experiment open in the analyzer (in memory; hydrated from / persisted
  // to the doc). Deduped by recordingIndex (re-marking a frame replaces it), sorted by tSeconds, capped
  // at MAX_KEY_MOMENTS. Cleared on leaving the analyzer. keyMomentsExpId tags which experiment these
  // belong to, so the persistence subscription only saves genuine edits to the current one (not a reset).
  keyMoments: KeyMoment[];
  keyMomentsExpId: string | null;
  addKeyMoment: (moment: KeyMoment) => void;
  removeKeyMoment: (recordingIndex: number) => void;
  setKeyMomentText: (recordingIndex: number, text: string) => void;
  // Re-anchor an existing moment (found by its old recordingIndex) to a fresh current-frame snapshot,
  // keeping its caption and any span end. Re-sorts by time. The player validates before calling.
  reanchorKeyMoment: (oldRecordingIndex: number, anchor: QaMoment) => void;
  // Move a span's END to a new frame (start unchanged, so no re-sort). The player validates end > start.
  reanchorKeyMomentEnd: (recordingIndex: number, endRecordingIndex: number, endTSeconds: number) => void;
  // Replace all key moments (hydration). `expId` tags whose they are (see keyMomentsExpId).
  setKeyMoments: (moments: KeyMoment[], expId: string) => void;

  // Two-step span marking: the owner marks a start frame (held here with its snapshot), plays to the end,
  // then marks the end — which combines the two into one span key moment and clears this. Cleared on nav.
  pendingSpanStart: KeyMoment | null;
  setPendingSpanStart: (moment: KeyMoment | null) => void;

  // Selected Q&A model (see MODEL_KEYS). Lifted into the store — not just the Q&A panel's local state —
  // so the player's right-click menu can reactively disable moment-attach when the model is text-only
  // (see isTextOnlyModel). Persisted to localStorage ('qa-model') across reloads.
  qaModel: QaModel;
  setQaModel: (model: QaModel) => void;

  // Player -> workspace: switch to the Ask AI workspace mode (e.g. after a right-click "Ask about this
  // moment" so the freshly attached chip is visible). The nonce makes a repeat request fire again.
  openAnalysisTabRequest: { nonce: number } | null;
  requestOpenAnalysisTab: () => void;

  // Sandbox banner -> header: open the "Save as" dialog (or the sign-in prompt) from the workspace's
  // sandbox notice, reusing the header's single SaveToMyExperiments dialog instead of a second copy.
  // The nonce makes a repeat request fire again.
  openSaveCopyRequest: { nonce: number } | null;
  requestOpenSaveCopy: () => void;

  // Which panel the analyzer's right-hand workspace shows. 'info' (description + facts) is the default;
  // 'charts' is co-visible with the player for the live probe/playback coupling; Ask AI and AI Report
  // are the wide-panel homes for the staff tools. Not persisted — resets to 'info' on entering an
  // experiment (clearAnalysisCaches).
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;

  // Chart display prefs (line width / symbols / grid / error bars), lifted out of the chart components'
  // local state so they survive the workspace unmounting the charts on a mode switch. Global (shared
  // across experiments) — a display preference, not per-clip data.
  lineChartSettings: LineChartSettings;
  setLineChartSettings: (patch: Partial<LineChartSettings>) => void;
  scatterChartSettings: ScatterChartSettings;
  setScatterChartSettings: (patch: Partial<ScatterChartSettings>) => void;

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
    authReady: false,
    setAuthReady(ready) {
      immerSet((state) => {
        state.authReady = ready;
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

    playSpanRequest: null,
    requestPlaySpan(startPlayerIndex, endPlayerIndex) {
      immerSet((state) => {
        state.playSpanRequest = {
          startPlayerIndex,
          endPlayerIndex,
          nonce: (state.playSpanRequest?.nonce ?? 0) + 1,
        };
      });
    },
    pauseRequest: null,
    requestPause() {
      immerSet((state) => {
        state.pauseRequest = { nonce: (state.pauseRequest?.nonce ?? 0) + 1 };
      });
    },
    playerPlaying: false,
    activeSpanStart: null,
    setPlayerPlaying(playing) {
      immerSet((state) => {
        state.playerPlaying = playing;
        // Playback stopping (end / pause / seek) ends the "this span is playing" state.
        if (!playing) state.activeSpanStart = null;
      });
    },
    setActiveSpanStart(recordingIndex) {
      immerSet((state) => {
        state.activeSpanStart = recordingIndex;
      });
    },
    playerFrameRate: null,
    setPlayerFrameRate(rate) {
      immerSet((state) => {
        state.playerFrameRate = rate;
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
    requestSnapshotMoment(purpose = 'qa', target) {
      immerSet((state) => {
        state.snapshotMomentRequest = { nonce: (state.snapshotMomentRequest?.nonce ?? 0) + 1, purpose, target };
      });
    },

    keyMoments: [],
    keyMomentsExpId: null,
    addKeyMoment(moment) {
      immerSet((state) => {
        // Dedupe by frame (re-marking replaces it), cap, keep time-ordered.
        const rest = state.keyMoments.filter((m) => m.recordingIndex !== moment.recordingIndex);
        if (rest.length >= MAX_KEY_MOMENTS) return;
        state.keyMoments = [...rest, moment].sort((a, b) => a.tSeconds - b.tSeconds);
      });
    },
    removeKeyMoment(recordingIndex) {
      immerSet((state) => {
        state.keyMoments = state.keyMoments.filter((m) => m.recordingIndex !== recordingIndex);
      });
    },
    setKeyMomentText(recordingIndex, text) {
      immerSet((state) => {
        const m = state.keyMoments.find((km) => km.recordingIndex === recordingIndex);
        if (m) m.text = text;
      });
    },
    reanchorKeyMoment(oldRecordingIndex, anchor) {
      immerSet((state) => {
        const m = state.keyMoments.find((km) => km.recordingIndex === oldRecordingIndex);
        if (!m) return;
        m.recordingIndex = anchor.recordingIndex;
        m.tSeconds = anchor.tSeconds;
        m.thumbnail = anchor.thumbnail;
        m.readings = anchor.readings;
        state.keyMoments.sort((a, b) => a.tSeconds - b.tSeconds);
      });
    },
    reanchorKeyMomentEnd(recordingIndex, endRecordingIndex, endTSeconds) {
      immerSet((state) => {
        const m = state.keyMoments.find((km) => km.recordingIndex === recordingIndex);
        if (!m) return;
        m.endRecordingIndex = endRecordingIndex;
        m.endTSeconds = endTSeconds;
      });
    },
    setKeyMoments(moments, expId) {
      immerSet((state) => {
        state.keyMoments = [...moments].sort((a, b) => a.tSeconds - b.tSeconds);
        state.keyMomentsExpId = expId;
      });
    },
    pendingSpanStart: null,
    setPendingSpanStart(moment) {
      immerSet((state) => {
        state.pendingSpanStart = moment;
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
    openSaveCopyRequest: null,
    requestOpenSaveCopy() {
      immerSet((state) => {
        state.openSaveCopyRequest = { nonce: (state.openSaveCopyRequest?.nonce ?? 0) + 1 };
      });
    },

    workspaceMode: 'info',
    setWorkspaceMode(mode) {
      immerSet((state) => {
        state.workspaceMode = mode;
      });
    },

    lineChartSettings: { lineWidth: 2, symbolCount: 0, symbolSize: 3, horizontalGrid: true, verticalGrid: true },
    setLineChartSettings(patch) {
      immerSet((state) => {
        state.lineChartSettings = { ...state.lineChartSettings, ...patch };
      });
    },
    scatterChartSettings: { lineWidth: 1.5, errorBars: false, horizontalGrid: true, verticalGrid: true },
    setScatterChartSettings(patch) {
      immerSet((state) => {
        state.scatterChartSettings = { ...state.scatterChartSettings, ...patch };
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
        state.playSpanRequest = null;
        state.pauseRequest = null;
        state.playerPlaying = false;
        state.activeSpanStart = null;
        state.playerFrameRate = null;
        state.attachedMoments = [];
        state.keyMoments = [];
        // Null the owner id so the persistence subscription treats this reset (which may fire while the
        // subscription is still live on analyzer unmount) as "not this experiment's edit" and skips the
        // save — otherwise it would write [] over the doc and wipe the saved moments.
        state.keyMomentsExpId = null;
        state.pendingSpanStart = null;
        state.snapshotMomentRequest = null;
        state.openAnalysisTabRequest = null;
        state.openSaveCopyRequest = null;
        state.workspaceMode = 'info';
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
