import { enableMapSet, produce } from 'immer';
import { create } from 'zustand';
import {
  Annotation,
  QaModel,
  QaMoment,
  KeyMoment,
  TComment,
  Experiment,
  ExperimentGraphOption,
  LineChartSettings,
  ScatterChartSettings,
  ProfileChartSettings,
  HistogramChartSettings,
  IsothermSettings,
  ProfileLine,
  TemperatureUnit,
  Thermometer,
  User,
  DEFAULT_MODEL,
  isModelKey,
} from '../types';

import { makeProfileLine, MAX_PROFILE_LINES } from '../utils/lineProfile';

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

// Chart display defaults (LineChartSettings / ScatterChartSettings live in types.ts — the persisted
// shape). The charts fall back to these when the open experiment has no saved chartSettings, so a
// fresh/legacy clip lands on a sane look; the first edit materialises chartSettings from them.
export const DEFAULT_LINE_CHART_SETTINGS: LineChartSettings = {
  lineWidth: 2,
  symbolCount: 0,
  symbolSize: 3,
  horizontalGrid: true,
  verticalGrid: true,
  frameStats: true, // T(t) shows the whole-frame min/max/mean overlay by default
};
export const DEFAULT_SCATTER_CHART_SETTINGS: ScatterChartSettings = {
  lineWidth: 1.5,
  errorBars: false,
  horizontalGrid: true,
  verticalGrid: true,
};
export const DEFAULT_PROFILE_CHART_SETTINGS: ProfileChartSettings = {
  lineWidth: 2,
  horizontalGrid: true,
  verticalGrid: true,
};
export const DEFAULT_HISTOGRAM_CHART_SETTINGS: HistogramChartSettings = {
  bins: 48,
  horizontalGrid: true,
  verticalGrid: true,
};
// Isotherms default to AUTO (levels re-derived per frame): lockedLevels null.
export const DEFAULT_ISOTHERM_SETTINGS: IsothermSettings = {
  lockedLevels: null,
};

// The Charts panel lays its plots out in a 2×2 grid, so at most this many chart options can be shown at
// once. The on-image overlays (isotherm / scaleBar / hotspots) render on the frame, not in the grid, so
// they don't count toward — and aren't limited by — this cap.
export const MAX_VISIBLE_CHARTS = 4;
export const CHART_GRAPH_OPTIONS: ExperimentGraphOption[] = [
  ExperimentGraphOption.time,
  ExperimentGraphOption.spaceX,
  ExperimentGraphOption.spaceY,
  ExperimentGraphOption.lineProfile,
  ExperimentGraphOption.histogram,
];
/** How many of the enabled graph options are grid charts (vs. on-image overlays). */
export const visibleChartCount = (opts?: ExperimentGraphOption[]) =>
  (opts ?? []).reduce((n, o) => (CHART_GRAPH_OPTIONS.includes(o) ? n + 1 : n), 0);

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

// ---- Analyzer undo/redo (Ctrl+Z) ----
// One immutable snapshot of the experiment's *spatial* analysis edits — the state that Ctrl+Z reverts:
// thermometers (placement / measuring area / name), the T(l) profile lines, and the on-image annotations.
// Chart/graph/isotherm/key-moment/description edits are deliberately NOT undoable (they have their own UI
// and text fields keep native undo). Selection ids ride along so undo restores the highlight, but they're
// excluded from the change signature (selecting must never create a history entry).
export interface AnalysisEditSnapshot {
  thermometers: Thermometer[];
  thermometersId: string[];
  profileLines: ProfileLine[];
  annotations: Annotation[];
  selectedThermometerId: string | null;
  selectedProfileLineId: string | null;
}

// Ceiling on the undo stack depth (enough to walk back a long editing session without unbounded memory).
export const MAX_ANALYZER_HISTORY = 50;

// Build the undoable snapshot for `expId` from a store state, deep-copying so later store mutations
// (per-frame value churn, further edits) can't alias into a frozen history entry.
export function buildAnalyzerSnapshot(state: CommonStoreState, expId: string): AnalysisEditSnapshot {
  const exp = state.experimentMap.get(expId);
  const ids = exp?.thermometersId ?? [];
  const thermometers = ids
    .map((id) => state.thermometerMap.get(id))
    .filter((t): t is Thermometer => !!t)
    .map((t) => ({ ...t }));
  return {
    thermometers,
    thermometersId: [...ids],
    profileLines: (exp?.profileLines ?? []).map((l) => ({ ...l })),
    annotations: (state.analyzerAnnotations.get(expId) ?? []).map((a) => ({ ...a })),
    selectedThermometerId: state.selectedThermometerId,
    selectedProfileLineId: state.selectedProfileLineId,
  };
}

// Change signature for the recorder: thermometer geometry/existence/name (NOT the per-frame `value`),
// profile-line endpoints/name, annotation anchor/offset/text/time. Mirrors useAnalysisPersistence's
// `sigOf` "drop value" discipline. Excludes selection — a bare click must not push an undo entry.
export function analyzerSnapshotSig(snap: AnalysisEditSnapshot): string {
  const t = snap.thermometers.map((x) => [
    x.id,
    x.name ?? null,
    x.x,
    x.y,
    x.unit,
    x.measuringAreaType ?? null,
    x.measuringAreaWidth ?? null,
    x.measuringAreaHeight ?? null,
  ]);
  const p = snap.profileLines.map((l) => [l.id, l.name ?? null, l.x1, l.y1, l.x2, l.y2]);
  const a = snap.annotations.map((x) => [
    x.id,
    x.x,
    x.y,
    x.dx ?? null,
    x.dy ?? null,
    x.note ?? '',
    x.time?.start ?? null,
    x.time?.end ?? null,
  ]);
  return JSON.stringify({ t, p, a });
}

// Write a snapshot back into the store (undo/redo). Runs inside an immer draft. Rebuilds this
// experiment's thermometers, its profile lines, and its annotation mirror, restores the selection (only
// if the target still exists), and bumps the two nonces so the annotation overlay reconciles and the
// player re-derives thermometer readings at the restored positions.
function applyAnalyzerSnapshot(state: CommonStoreState, expId: string, snap: AnalysisEditSnapshot): void {
  const exp = state.experimentMap.get(expId);
  (exp?.thermometersId ?? []).forEach((id) => state.thermometerMap.delete(id));
  snap.thermometers.forEach((t) => state.thermometerMap.set(t.id, { ...t }));
  if (exp) {
    state.experimentMap.set(expId, {
      ...exp,
      thermometersId: [...snap.thermometersId],
      profileLines: snap.profileLines.map((l) => ({ ...l })),
    });
  }
  state.analyzerAnnotations.set(
    expId,
    snap.annotations.map((a) => ({ ...a })),
  );
  state.annotationsRestoreNonce += 1;
  state.thermoRefreshNonce += 1;
  // Drop any selection/hover whose target the restore removed.
  state.selectedThermometerId =
    snap.selectedThermometerId && state.thermometerMap.has(snap.selectedThermometerId)
      ? snap.selectedThermometerId
      : null;
  state.selectedProfileLineId =
    snap.selectedProfileLineId && snap.profileLines.some((l) => l.id === snap.selectedProfileLineId)
      ? snap.selectedProfileLineId
      : null;
  if (state.hoveredThermometerId && !state.thermometerMap.has(state.hoveredThermometerId))
    state.hoveredThermometerId = null;
  if (state.hoveredProfileLineId && !snap.profileLines.some((l) => l.id === state.hoveredProfileLineId))
    state.hoveredProfileLineId = null;
}

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
  // The selected T(l) transect (like selectedThermometerId) — drives the delete-key shortcut + highlight.
  selectedProfileLineId: string | null;
  selectProfileLine: (id: string | null) => void;

  // The thermometer currently hovered (in the image). Highlights its series in the charts and
  // dims the others. null = none hovered.
  hoveredThermometerId: string | null;
  hoverThermometer: (id: string | null) => void;

  // The profile line (T(l) transect) currently hovered in the image. Highlights its series in the
  // T(l) chart and dims the others — the transect analogue of hoveredThermometerId. null = none.
  hoveredProfileLineId: string | null;
  hoverProfileLine: (id: string | null) => void;

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

  // Add / remove a chart or isotherm option on the experiment's graphsOptions (the persisted set of
  // enabled plots + the isotherm overlay). Pure store surgery — it does NOT flip workspaceMode: the
  // chart toggles now live inside the Charts tab, so the user is already looking at the plots; the
  // isotherm toggle stays on the player toolbar and must not yank the workspace away either.
  toggleGraphOption: (expId: string, option: ExperimentGraphOption) => void;

  // Which chart the Charts tab is showing full-panel (T(t)/T(x)/T(y)), or null for the normal layout.
  // Session-only (never persisted) — a "look closer at this one" affordance, not per-clip data. Cleared
  // when its chart is toggled off and on leaving the analyzer.
  maximizedChart: ExperimentGraphOption | null;
  setMaximizedChart: (option: ExperimentGraphOption | null) => void;

  // Chart display prefs (line width / symbols / grid / error bars / frame overlay). Stored ON the open
  // experiment (experimentMap[id].chartSettings) exactly like graphsOptions — NOT a global slice — so the
  // cached experiment and the charts stay in sync across a revisit, a viewer sees the owner's saved
  // appearance, and the owner's auto-save (useAnalysisPersistence) persists them. Charts read the current
  // experiment's settings, falling back to DEFAULT_* when unset; these actions patch one plane, materialising
  // the object from the defaults on the first edit.
  setLineChartSetting: (expId: string, patch: Partial<LineChartSettings>) => void;
  setScatterChartSetting: (expId: string, patch: Partial<ScatterChartSettings>) => void;
  setProfileChartSetting: (expId: string, patch: Partial<ProfileChartSettings>) => void;
  setHistogramChartSetting: (expId: string, patch: Partial<HistogramChartSettings>) => void;
  // Isotherm overlay levels (locked/auto). Not a grid chart, but stored in chartSettings so it rides the
  // same owner auto-save / viewer-sandbox path as the other display prefs.
  setIsothermSetting: (expId: string, patch: Partial<IsothermSettings>) => void;

  // The T(l) line-profile transects on the open experiment (experimentMap[id].profileLines), stored like
  // graphsOptions/chartSettings so the owner's auto-save persists them and a viewer edit rides in the session.
  addProfileLine: (expId: string) => void; // append a new default line (capped at MAX_PROFILE_LINES)
  updateProfileLine: (expId: string, line: ProfileLine) => void; // replace one line, matched by id
  renameProfileLine: (expId: string, id: string, name: string | undefined) => void; // undefined clears the name
  removeProfileLine: (expId: string, id: string) => void;
  removeAllProfileLines: (expId: string) => void;

  commentMap: Map<string, TComment>;
  setComment: (id: string, comment: TComment) => void;

  // Live annotations for the experiment open in the analyzer, mirrored here from <Annotations>
  // (whose notes are local component state, not otherwise in this store). Lets a clone — "Save to My
  // Experiments" / "Save clip" — capture the viewer's local sandbox annotation edits, which the
  // Firestore source lacks. Keyed by expId; cleared with the other caches on leaving the analyzer.
  analyzerAnnotations: Map<string, Annotation[]>;
  setAnalyzerAnnotations: (expId: string, annotations: Annotation[]) => void;

  // ---- Analyzer undo/redo (Ctrl+Z) ----
  // Snapshot history for the current experiment's spatial edits (thermometers / profile lines /
  // annotations). `present` is the last-recorded state; undo moves it into `future` and pops `past`.
  // Scoped to one experiment and cleared on leaving the analyzer (clearAnalysisCaches).
  analyzerHistory: {
    expId: string | null;
    present: AnalysisEditSnapshot | null;
    past: AnalysisEditSnapshot[];
    future: AnalysisEditSnapshot[];
  };
  // Bumped when undo/redo restores annotations, so <Annotations> (whose notes are component state)
  // reloads them from analyzerAnnotations and reconciles Firestore for the owner.
  annotationsRestoreNonce: number;
  // Bumped when undo/redo moves thermometers, so the player re-derives their readings from the current
  // frame at the restored positions (value isn't part of the snapshot signature).
  thermoRefreshNonce: number;
  // Establish the baseline (present) for `expId`, clearing past/future. Called once the analysis has
  // loaded (recorder's `ready`).
  initAnalyzerHistory: (expId: string, snapshot: AnalysisEditSnapshot) => void;
  // Replace `present` WITHOUT touching past/future — for the async annotation load landing after the
  // baseline, so it re-baselines instead of registering as an undoable edit.
  rebaselineAnalyzerHistory: (snapshot: AnalysisEditSnapshot) => void;
  // Record a settled edit: push the old present onto past (capped), set present = snapshot, clear redo.
  commitAnalyzerHistory: (snapshot: AnalysisEditSnapshot) => void;
  undoAnalyzer: () => void;
  redoAnalyzer: () => void;
  resetAnalyzerHistory: () => void;

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
    selectedProfileLineId: null,
    selectProfileLine(id) {
      immerSet((state) => {
        state.selectedProfileLineId = id;
      });
    },
    hoveredThermometerId: null,
    hoverThermometer(id) {
      immerSet((state) => {
        state.hoveredThermometerId = id;
      });
    },
    hoveredProfileLineId: null,
    hoverProfileLine(id) {
      immerSet((state) => {
        state.hoveredProfileLineId = id;
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

    toggleGraphOption(expId, option) {
      immerSet((state) => {
        const experiment = state.experimentMap.get(expId);
        if (!experiment) return;
        const options = experiment.graphsOptions ? [...experiment.graphsOptions] : [];
        const idx = options.indexOf(option);
        if (idx === -1) {
          // The Charts grid holds at most MAX_VISIBLE_CHARTS plots; refuse to enable a further chart beyond
          // that (overlays render on the image, not the grid, so they're never capped). The chip UI disables
          // inactive chips at the cap and the add-line handlers warn, so this is the last-line invariant.
          if (CHART_GRAPH_OPTIONS.includes(option) && visibleChartCount(options) >= MAX_VISIBLE_CHARTS) return;
          options.push(option);
        } else {
          options.splice(idx, 1);
          // The line overlay is independent of the T(l) chart (it renders whenever a line exists), so
          // turning the chart off leaves the lines — and any selection — untouched on the image.
        }
        // Any chip toggle exits the maximized single-chart view. While one chart is expanded it fills the
        // whole panel, so enabling another plot — or turning one off — would otherwise leave the maximized
        // chart in place and the change invisible, which reads as a dead button. Drop back to the grid so
        // the result shows. (Turning off the maximized chart itself lands here too.)
        if (state.maximizedChart !== null) state.maximizedChart = null;
        state.experimentMap.set(expId, { ...experiment, graphsOptions: options });
      });
    },

    maximizedChart: null,
    setMaximizedChart(option) {
      immerSet((state) => {
        state.maximizedChart = option;
      });
    },

    // The three chart-setting patchers all spread the previous chartSettings FIRST, then re-assert the
    // required line + scatter planes, so editing one plane never drops a sibling plane (profile — or any
    // key added later). Each plane materialises from its defaults the first time it's touched.
    setLineChartSetting(expId, patch) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const prev = exp.chartSettings;
        const line = { ...(prev?.line ?? DEFAULT_LINE_CHART_SETTINGS), ...patch };
        const scatter = prev?.scatter ?? DEFAULT_SCATTER_CHART_SETTINGS;
        state.experimentMap.set(expId, { ...exp, chartSettings: { ...prev, line, scatter } });
      });
    },
    setScatterChartSetting(expId, patch) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const prev = exp.chartSettings;
        const scatter = { ...(prev?.scatter ?? DEFAULT_SCATTER_CHART_SETTINGS), ...patch };
        const line = prev?.line ?? DEFAULT_LINE_CHART_SETTINGS;
        state.experimentMap.set(expId, { ...exp, chartSettings: { ...prev, line, scatter } });
      });
    },
    setProfileChartSetting(expId, patch) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const prev = exp.chartSettings;
        const profile = { ...(prev?.profile ?? DEFAULT_PROFILE_CHART_SETTINGS), ...patch };
        const line = prev?.line ?? DEFAULT_LINE_CHART_SETTINGS;
        const scatter = prev?.scatter ?? DEFAULT_SCATTER_CHART_SETTINGS;
        state.experimentMap.set(expId, { ...exp, chartSettings: { ...prev, line, scatter, profile } });
      });
    },
    setHistogramChartSetting(expId, patch) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const prev = exp.chartSettings;
        const histogram = { ...(prev?.histogram ?? DEFAULT_HISTOGRAM_CHART_SETTINGS), ...patch };
        const line = prev?.line ?? DEFAULT_LINE_CHART_SETTINGS;
        const scatter = prev?.scatter ?? DEFAULT_SCATTER_CHART_SETTINGS;
        state.experimentMap.set(expId, { ...exp, chartSettings: { ...prev, line, scatter, histogram } });
      });
    },
    setIsothermSetting(expId, patch) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const prev = exp.chartSettings;
        // `lockedLevels` is always concrete (array or null) — never undefined — so nothing undefined reaches
        // Firestore (chartSettings is persisted whole). Same materialise-line+scatter discipline as siblings.
        const isotherm = { ...(prev?.isotherm ?? DEFAULT_ISOTHERM_SETTINGS), ...patch };
        const line = prev?.line ?? DEFAULT_LINE_CHART_SETTINGS;
        const scatter = prev?.scatter ?? DEFAULT_SCATTER_CHART_SETTINGS;
        state.experimentMap.set(expId, { ...exp, chartSettings: { ...prev, line, scatter, isotherm } });
      });
    },
    addProfileLine(expId) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const lines = exp.profileLines ?? [];
        if (lines.length >= MAX_PROFILE_LINES) return;
        const line = makeProfileLine(lines.length);
        state.experimentMap.set(expId, { ...exp, profileLines: [...lines, line] });
        // Select the new line so it's highlighted on the image — the visible feedback for the add, now
        // that adding a line no longer opens the Charts panel.
        state.selectedProfileLineId = line.id;
      });
    },
    updateProfileLine(expId, line) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const lines = exp.profileLines ?? [];
        state.experimentMap.set(expId, { ...exp, profileLines: lines.map((l) => (l.id === line.id ? line : l)) });
      });
    },
    renameProfileLine(expId, id, name) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const lines = exp.profileLines ?? [];
        state.experimentMap.set(expId, {
          ...exp,
          profileLines: lines.map((l) => (l.id === id ? { ...l, name } : l)),
        });
      });
    },
    removeProfileLine(expId, id) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        const lines = exp.profileLines ?? [];
        state.experimentMap.set(expId, { ...exp, profileLines: lines.filter((l) => l.id !== id) });
        if (state.selectedProfileLineId === id) state.selectedProfileLineId = null;
        if (state.hoveredProfileLineId === id) state.hoveredProfileLineId = null;
      });
    },
    removeAllProfileLines(expId) {
      immerSet((state) => {
        const exp = state.experimentMap.get(expId);
        if (!exp) return;
        state.experimentMap.set(expId, { ...exp, profileLines: [] });
        state.selectedProfileLineId = null;
        state.hoveredProfileLineId = null;
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
    analyzerHistory: { expId: null, present: null, past: [], future: [] },
    annotationsRestoreNonce: 0,
    thermoRefreshNonce: 0,
    initAnalyzerHistory(expId, snapshot) {
      immerSet((state) => {
        state.analyzerHistory = { expId, present: snapshot, past: [], future: [] };
      });
    },
    rebaselineAnalyzerHistory(snapshot) {
      immerSet((state) => {
        if (state.analyzerHistory.present) state.analyzerHistory.present = snapshot;
      });
    },
    commitAnalyzerHistory(snapshot) {
      immerSet((state) => {
        const h = state.analyzerHistory;
        if (!h.present) {
          h.present = snapshot;
          return;
        }
        if (analyzerSnapshotSig(h.present) === analyzerSnapshotSig(snapshot)) return;
        h.past.push(h.present);
        if (h.past.length > MAX_ANALYZER_HISTORY) h.past.shift();
        h.present = snapshot;
        h.future = [];
      });
    },
    undoAnalyzer() {
      immerSet((state) => {
        const h = state.analyzerHistory;
        if (!h.expId || !h.present || h.past.length === 0) return;
        h.future.unshift(h.present);
        const prev = h.past.pop() as AnalysisEditSnapshot;
        h.present = prev;
        applyAnalyzerSnapshot(state, h.expId, prev);
      });
    },
    redoAnalyzer() {
      immerSet((state) => {
        const h = state.analyzerHistory;
        if (!h.expId || !h.present || h.future.length === 0) return;
        h.past.push(h.present);
        const next = h.future.shift() as AnalysisEditSnapshot;
        h.present = next;
        applyAnalyzerSnapshot(state, h.expId, next);
      });
    },
    resetAnalyzerHistory() {
      immerSet((state) => {
        state.analyzerHistory = { expId: null, present: null, past: [], future: [] };
      });
    },
    clearAnalysisCaches() {
      immerSet((state) => {
        state.analyzerHistory = { expId: null, present: null, past: [], future: [] };
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
        state.maximizedChart = null;
        state.selectedThermometerId = null;
        state.selectedProfileLineId = null;
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
