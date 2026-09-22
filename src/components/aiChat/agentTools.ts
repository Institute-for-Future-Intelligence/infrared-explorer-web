import type { NavigateFunction } from 'react-router-dom';
import { Modal } from 'antd';
import { collection, doc, getDoc, getDocs, orderBy, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../../services/firebase';
import { getExperimentData } from '../../services/ai';
import useCommonStore, {
  CHART_GRAPH_OPTIONS,
  MAX_KEY_MOMENTS,
  MAX_VISIBLE_CHARTS,
  visibleChartCount,
  WorkspaceMode,
} from '../../stores/common';
import { Experiment, ExperimentDoc, ExperimentGraphOption, ExperimentType, KeyMoment, ProfileLine } from '../../types';
import { isStaff } from '../../utils/staff';
import { MAX_PROFILE_LINES, MIN_PROFILE_LENGTH } from '../../utils/lineProfile';
import { playerRegistry } from './playerRegistry';
import { annotationRegistry } from './annotationRegistry';

// The client half of the Lab Assistant's tools: execution + the app-state snapshot the model is given.
// The tool SCHEMAS are authoritative server-side (functions/src/index.ts AGENT_TOOLS) — keep names in
// sync. The tools search / list / open experiments and navigate; read thermal data (delegated to the
// getExperimentData callable, which serves every experiment kind); and operate the analyzer — probes,
// notes, profile lines, key moments, charts and overlays, the workspace tab, undo/redo — through the
// store and the two component bridges (playerRegistry for the playhead and frame-seeded probes,
// annotationRegistry for the notes, whose state lives in the overlay component).

// A thermometer as reported to the model.
interface CtxThermometer {
  label: string; // positional T1, T2, … (index in the experiment's thermometersId)
  name: string | null;
  aiPlaced?: boolean; // placed by the Lab Assistant itself, not by the student's hand
  x: number;
  y: number;
  areaType: string;
  reading: number | null; // latest on-screen value (may be null before frames load)
  unit: string;
}

// An annotation as reported to the model.
interface CtxAnnotation {
  label: string; // A1, A2, … (render order)
  note: string;
  x: number;
  y: number;
  time: { start: number; end: number } | null;
}

// A profile line (T(l) transect) as reported to the model.
interface CtxProfileLine {
  label: string; // L1, L2, … (index in the experiment's profileLines)
  name: string | null;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lengthCm: number | null;
  selected?: boolean;
}

// A key moment (the owner's captioned chapter) as reported to the model.
interface CtxKeyMoment {
  label: string; // K1, K2, … (time order)
  seconds: number;
  endSeconds?: number; // present for a range
  text: string | null;
}

export interface AgentContext {
  page: string; // route path, e.g. '/experiments/abc' or '/home'
  experimentOpen: boolean;
  experiment: {
    id: string;
    title: string | null;
    subject: string | null;
    kind: string; // 'recording' | 'video' | 'photos' | 'unknown'
    duration?: number; // seconds (recording / video)
    photoCount?: number; // photo set
    isOwner: boolean;
  } | null;
  thermometers: CtxThermometer[];
  annotations: CtxAnnotation[];
  profileLines: CtxProfileLine[];
  keyMoments: CtxKeyMoment[];
  // Which Charts-tab plots and on-image overlays are on, by the names the tools use.
  charts: { on: string[]; maximized: string | null; overlays: string[] } | null;
  workspaceTab: string | null;
  // Seconds into the clip — or, on a photo set, the photo number (1-based) — when a player is live.
  playhead: { seconds: number; totalSeconds: number } | { photo: number; photoCount: number } | null;
  temperatureUnit: string;
}

// Parse the live analyzer experiment id from the URL path (/experiments/<id>). Read from
// window.location (not a react-router snapshot) so it stays correct mid tool-loop, right after navigate.
function currentPath(): string {
  return window.location.pathname || '/';
}
function openExperimentId(): string | null {
  const m = currentPath().match(/^\/experiments\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function openExperiment(): { id: string; exp: Experiment } | null {
  const id = openExperimentId();
  const exp = id ? useCommonStore.getState().experimentMap.get(id) : undefined;
  return id && exp ? { id, exp } : null;
}
const isPhotoSet = (exp: Experiment) => exp.sourceType === ExperimentType.Photos;
const isOwnerOf = (exp: Experiment) => {
  const user = useCommonStore.getState().user;
  return !!user && exp.ownerId === user.id;
};

// --- Charts / overlays: the names the tools speak ↔ the store's graph options -------------------------
const CHART_BY_NAME: Record<string, ExperimentGraphOption> = {
  'T(t)': ExperimentGraphOption.time,
  'T(x)': ExperimentGraphOption.spaceX,
  'T(y)': ExperimentGraphOption.spaceY,
  'T(l)': ExperimentGraphOption.lineProfile,
  'N(T)': ExperimentGraphOption.histogram,
};
const OVERLAY_BY_NAME: Record<string, ExperimentGraphOption> = {
  isotherms: ExperimentGraphOption.isotherm,
  scale_bar: ExperimentGraphOption.scaleBar,
  hotspots: ExperimentGraphOption.hotspots,
  diff: ExperimentGraphOption.diff,
};
const nameOfOption = (option: ExperimentGraphOption): string | null => {
  for (const [name, o] of Object.entries(CHART_BY_NAME)) if (o === option) return name;
  for (const [name, o] of Object.entries(OVERLAY_BY_NAME)) if (o === option) return name;
  return null;
};
// Lenient lookup: "T(t)", "t(t)", "T (t)", "time", "histogram" … all land on the same option.
const CHART_ALIASES: Record<string, string> = {
  tt: 'T(t)',
  time: 'T(t)',
  tx: 'T(x)',
  ty: 'T(y)',
  tl: 'T(l)',
  line: 'T(l)',
  profile: 'T(l)',
  nt: 'N(T)',
  histogram: 'N(T)',
};
function resolveChart(raw: unknown): { name: string; option: ExperimentGraphOption } | null {
  const s = String(raw ?? '').trim();
  if (CHART_BY_NAME[s] !== undefined) return { name: s, option: CHART_BY_NAME[s] };
  const key = s.toLowerCase().replace(/[^a-z]/g, '');
  const name = CHART_ALIASES[key];
  return name ? { name, option: CHART_BY_NAME[name] } : null;
}
const OVERLAY_ALIASES: Record<string, string> = {
  isotherm: 'isotherms',
  isotherms: 'isotherms',
  contours: 'isotherms',
  scalebar: 'scale_bar',
  scale: 'scale_bar',
  colorbar: 'scale_bar',
  hotspots: 'hotspots',
  hotspot: 'hotspots',
  markers: 'hotspots',
  diff: 'diff',
  difference: 'diff',
  delta: 'diff',
};
function resolveOverlay(raw: unknown): { name: string; option: ExperimentGraphOption } | null {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const name = OVERLAY_ALIASES[key];
  return name ? { name, option: OVERLAY_BY_NAME[name] } : null;
}

// Workspace tabs: the tool's names ↔ the store's modes, and whether each is offered on this experiment
// (mirrors WorkspacePanel's showAskAi / showReport / showTwin).
const TAB_BY_NAME: Record<string, WorkspaceMode> = {
  info: 'info',
  charts: 'charts',
  ask_ai: 'askAI',
  ai_report: 'aiReport',
  digital_twin: 'twin',
};
const nameOfTab = (mode: WorkspaceMode): string => Object.entries(TAB_BY_NAME).find(([, m]) => m === mode)?.[0] ?? mode;
function tabAvailable(mode: WorkspaceMode, exp: Experiment): string | null {
  const staff = isStaff(useCommonStore.getState().user);
  const owner = isOwnerOf(exp);
  const kind = exp.sourceType;
  switch (mode) {
    case 'askAI':
      if (!staff) return 'Ask AI is available to staff accounts only.';
      if (kind !== ExperimentType.Recording && kind !== ExperimentType.Video)
        return 'Ask AI is not available on a photo set (recordings and videos only).';
      return null;
    case 'aiReport':
      if (!staff) return 'The AI Report tab is available to staff accounts only.';
      if (!owner && !exp.aiReport) return 'This experiment has no AI report yet, and only its owner can generate one.';
      return null;
    case 'twin':
      if (kind !== ExperimentType.Recording && kind !== ExperimentType.Photos)
        return 'A digital twin is built from a recording or a photo set only.';
      if (!owner && !exp.twinScene) return 'This experiment has no digital twin yet, and only its owner can build one.';
      return null;
    default:
      return null;
  }
}

// Key moments live in the store while an experiment is open (hydrated from the doc), so read them from
// there; fall back to the doc's stored form if the store is tagged for another experiment.
function keyMomentsOf(id: string, exp: Experiment): KeyMoment[] {
  const state = useCommonStore.getState();
  const list: KeyMoment[] =
    state.keyMomentsExpId === id
      ? state.keyMoments
      : (exp.keyMoments ?? []).map((m) => ({ ...m, thumbnail: '', readings: [] }));
  return [...list].sort((a, b) => a.tSeconds - b.tSeconds);
}
const ctxKeyMoments = (id: string, exp: Experiment): CtxKeyMoment[] =>
  keyMomentsOf(id, exp).map((m, i) => ({
    label: `K${i + 1}`,
    seconds: m.tSeconds,
    ...(typeof m.endTSeconds === 'number' ? { endSeconds: m.endTSeconds } : {}),
    text: m.text?.trim() || null,
  }));

const ctxProfileLines = (exp: Experiment): CtxProfileLine[] => {
  const selected = useCommonStore.getState().selectedProfileLineId;
  return (exp.profileLines ?? []).map((l, i) => ({
    label: `L${i + 1}`,
    name: l.name?.trim() || null,
    x1: round3(l.x1),
    y1: round3(l.y1),
    x2: round3(l.x2),
    y2: round3(l.y2),
    lengthCm: typeof l.lengthCm === 'number' && Number.isFinite(l.lengthCm) ? l.lengthCm : null,
    ...(l.id === selected ? { selected: true } : {}),
  }));
};

const ctxPlayhead = (exp: Experiment): AgentContext['playhead'] => {
  const ctrl = playerRegistry.controller;
  if (!ctrl) return null;
  const p = ctrl.getPlayhead();
  // A set's controller counts places: playerIndex k is the (k+1)-th photo in the viewing order.
  if (isPhotoSet(exp)) return { photo: p.playerIndex + 1, photoCount: p.lastFrameIndex + 1 };
  return { seconds: p.seconds, totalSeconds: p.totalSeconds };
};

/** Build the app-state snapshot injected into the model each turn (what's open, its probes, notes, lines,
 *  key moments, charts, the tab, the playhead, the unit). */
export function buildAgentContext(): AgentContext {
  const state = useCommonStore.getState();
  const open = openExperiment();
  const exp = open?.exp;
  const thermometers: CtxThermometer[] = exp
    ? (exp.thermometersId ?? [])
        .map((id, i): CtxThermometer | null => {
          const t = state.thermometerMap.get(id);
          if (!t) return null;
          return {
            label: `T${i + 1}`,
            name: t.name || null,
            ...(t.aiPlaced ? { aiPlaced: true } : {}),
            x: Number(t.x.toFixed(3)),
            y: Number(t.y.toFixed(3)),
            areaType: t.measuringAreaType ?? 'point',
            reading: Number.isFinite(t.value) ? Number(t.value.toFixed(1)) : null,
            unit: t.unit ?? state.temperatureUnit,
          };
        })
        .filter((x): x is CtxThermometer => x !== null)
    : [];
  const options = exp?.graphsOptions ?? [];
  return {
    // The route tells the model which page it is on, but a profile route carries the profile
    // owner's account id in the path and this context is sent to third-party AI providers. The
    // privacy policy states that no account identifier goes into those requests, so the id
    // segment is masked; the model only needs to know it is "a profile page".
    page: currentPath().replace(/^\/(users|admin\/users)\/[^/]+/, '/$1/:id'),
    experimentOpen: !!exp,
    experiment:
      open && exp
        ? {
            id: open.id,
            title: exp.displayName ?? null,
            subject: exp.subject ?? null,
            kind: exp.sourceType ?? 'unknown',
            ...(isPhotoSet(exp)
              ? { photoCount: Math.max(1, Math.floor(exp.photoCount ?? 1)) }
              : { duration: exp.duration ?? 0 }),
            isOwner: isOwnerOf(exp),
          }
        : null,
    thermometers,
    annotations:
      annotationRegistry.controller
        ?.list()
        .map((a, i) => ({ label: `A${i + 1}`, note: a.note, x: a.x, y: a.y, time: a.time })) ?? [],
    profileLines: exp ? ctxProfileLines(exp) : [],
    keyMoments: open && exp && !isPhotoSet(exp) ? ctxKeyMoments(open.id, exp) : [],
    charts: exp
      ? {
          on: options.filter((o) => CHART_GRAPH_OPTIONS.includes(o)).map((o) => nameOfOption(o) ?? String(o)),
          maximized: state.maximizedChart !== null ? nameOfOption(state.maximizedChart) : null,
          overlays: options.filter((o) => !CHART_GRAPH_OPTIONS.includes(o)).flatMap((o) => nameOfOption(o) ?? []),
        }
      : null,
    workspaceTab: exp ? nameOfTab(state.workspaceMode) : null,
    playhead: exp ? ctxPlayhead(exp) : null,
    temperatureUnit: state.temperatureUnit,
  };
}

/** Tool names usable given the current context. Search / navigation / data / unit tools are always
 *  available; the analyzer tools when an experiment is open; placing a thermometer, seeking and marking
 *  key moments need the live player; notes need the annotation overlay; key moments are the owner's and
 *  exist on a timeline only (not on a photo set). */
export function enabledToolsFor(ctx: AgentContext): string[] {
  const tools = [
    'search_experiments',
    'list_my_experiments',
    'open_experiment',
    'navigate_to',
    'read_experiment_data',
    'set_temperature_unit',
  ];
  if (ctx.experimentOpen) {
    tools.push(
      'list_thermometers',
      'rename_thermometer',
      'select_thermometer',
      'remove_thermometer',
      'remove_all_thermometers',
      'list_profile_lines',
      'add_profile_line',
      'rename_profile_line',
      'select_profile_line',
      'remove_profile_line',
      'remove_all_profile_lines',
      'toggle_chart',
      'maximize_chart',
      'toggle_overlay',
      'set_isotherm_levels',
      'show_workspace_tab',
      'undo_redo',
    );
  }
  if (playerRegistry.controller) {
    tools.push('add_thermometer', 'seek_to_time', 'set_playback');
  }
  // The annotation overlay is present whenever an experiment is open in the analyzer (any kind).
  if (annotationRegistry.controller) {
    tools.push('list_annotations', 'add_annotation', 'edit_annotation', 'remove_annotation');
  }
  if (ctx.experiment && ctx.experiment.kind !== 'photos') {
    tools.push('list_key_moments');
    if (ctx.experiment.isOwner && playerRegistry.controller) {
      tools.push('add_key_moment', 'edit_key_moment', 'remove_key_moment');
    }
  }
  return tools;
}

// Top-level app pages the assistant can navigate to (navigate_to tool). Aliases map to the same route.
// 'my_profile' / 'profile' are resolved dynamically in the handler (the route carries the user's id).
const PAGE_ROUTES: Record<string, string> = {
  home: '/',
  gallery: '/',
  showcase: '/',
  community: '/community',
  streetview: '/streetview',
  street_view: '/streetview',
  me: '/me',
  my_experiments: '/myExperimentsList',
  recent: '/recent',
  history: '/recent',
  raw: '/raw',
  classroom: '/classroom',
  my_classes: '/classroom',
  trash: '/trash',
  settings: '/settings',
  about: '/about',
  contact: '/contact',
  admin_users: '/admin/users',
  admin_experiments: '/admin/experiments',
  admin_streetview_reports: '/admin/streetview-reports',
};

// Resolve an annotation identifier the model uses (an A-label like "A2", a snippet of its note, or a raw
// id) to its id + label within the open experiment. Returns null if nothing matches.
function resolveAnnotation(identifier: string): { id: string; label: string; note: string } | null {
  const list = annotationRegistry.controller?.list() ?? [];
  const raw = identifier.trim();
  const norm = raw.toLowerCase();
  const labelMatch = norm.match(/^a\s*(\d+)$/);
  if (labelMatch) {
    const i = parseInt(labelMatch[1], 10) - 1;
    if (i >= 0 && i < list.length) return { id: list[i].id, label: `A${i + 1}`, note: list[i].note };
  }
  const byId = list.findIndex((a) => a.id === raw);
  if (byId >= 0) return { id: list[byId].id, label: `A${byId + 1}`, note: list[byId].note };
  let idx = list.findIndex((a) => a.note.toLowerCase() === norm);
  if (idx < 0 && norm.length >= 3) idx = list.findIndex((a) => a.note.toLowerCase().includes(norm));
  if (idx >= 0) return { id: list[idx].id, label: `A${idx + 1}`, note: list[idx].note };
  return null;
}

// Resolve an identifier the model uses for a thermometer (a T-label like "T2", a user-given name, or a
// raw id) to its id + positional label within the open experiment. Returns null if nothing matches.
function resolveThermometer(identifier: string): { id: string; label: string } | null {
  const state = useCommonStore.getState();
  const expId = openExperimentId();
  const ids = (expId ? state.experimentMap.get(expId) : undefined)?.thermometersId ?? [];
  const raw = identifier.trim();
  const norm = raw.toLowerCase();
  const labelMatch = norm.match(/^t\s*(\d+)$/);
  if (labelMatch) {
    const i = parseInt(labelMatch[1], 10) - 1;
    if (i >= 0 && i < ids.length) return { id: ids[i], label: `T${i + 1}` };
  }
  const byId = ids.indexOf(raw);
  if (byId >= 0) return { id: raw, label: `T${byId + 1}` };
  for (let i = 0; i < ids.length; i++) {
    const t = state.thermometerMap.get(ids[i]);
    if (t?.name && t.name.toLowerCase() === norm) return { id: ids[i], label: `T${i + 1}` };
  }
  return null;
}

// Resolve a profile-line identifier (an L-label like "L2", its name, or a raw id) to the line + its label.
function resolveProfileLine(identifier: string): { line: ProfileLine; label: string } | null {
  const open = openExperiment();
  const lines = open?.exp.profileLines ?? [];
  const raw = identifier.trim();
  const norm = raw.toLowerCase();
  const labelMatch = norm.match(/^l\s*(\d+)$/);
  if (labelMatch) {
    const i = parseInt(labelMatch[1], 10) - 1;
    if (i >= 0 && i < lines.length) return { line: lines[i], label: `L${i + 1}` };
  }
  let idx = lines.findIndex((l) => l.id === raw);
  if (idx < 0) idx = lines.findIndex((l) => l.name?.trim().toLowerCase() === norm);
  if (idx >= 0) return { line: lines[idx], label: `L${idx + 1}` };
  return null;
}
const profileLabelForId = (id: string): string => {
  const lines = openExperiment()?.exp.profileLines ?? [];
  const i = lines.findIndex((l) => l.id === id);
  return i >= 0 ? `L${i + 1}` : id;
};

// Resolve a key-moment identifier (a K-label like "K2", a time in seconds, or a caption snippet).
function resolveKeyMoment(identifier: string): { moment: KeyMoment; label: string } | null {
  const open = openExperiment();
  if (!open) return null;
  const list = keyMomentsOf(open.id, open.exp);
  const raw = identifier.trim();
  const norm = raw.toLowerCase();
  const labelMatch = norm.match(/^k\s*(\d+)$/);
  if (labelMatch) {
    const i = parseInt(labelMatch[1], 10) - 1;
    if (i >= 0 && i < list.length) return { moment: list[i], label: `K${i + 1}` };
  }
  const asTime = Number(norm.replace(/s(ec(onds?)?)?$/, '').trim());
  if (norm && Number.isFinite(asTime)) {
    let best = -1;
    let bestGap = Infinity;
    list.forEach((m, i) => {
      const gap = Math.abs(m.tSeconds - asTime);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    if (best >= 0 && bestGap <= 0.6) return { moment: list[best], label: `K${best + 1}` };
  }
  let idx = list.findIndex((m) => (m.text ?? '').trim().toLowerCase() === norm);
  if (idx < 0 && norm.length >= 3) idx = list.findIndex((m) => (m.text ?? '').toLowerCase().includes(norm));
  if (idx >= 0) return { moment: list[idx], label: `K${idx + 1}` };
  return null;
}

// Positional label (T1, T2, …) of a thermometer id in the open experiment, or the id if not found.
function labelForId(id: string): string {
  const expId = openExperimentId();
  const ids = (expId ? useCommonStore.getState().experimentMap.get(expId) : undefined)?.thermometersId ?? [];
  const i = ids.indexOf(id);
  return i >= 0 ? `T${i + 1}` : id;
}

// Ask the user to confirm a destructive action (delete). Resolves true on OK, false on cancel — this is
// the confirmation gate for the agent's mutating tools.
function confirmAction(title: string): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      okText: 'Delete',
      cancelText: 'Cancel',
      okButtonProps: { danger: true },
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// After a seek the player fetches the frame's image asynchronously; a key moment snapshotted right away
// would carry the previous frame's thumbnail. Give it a beat before marking.
const FRAME_SETTLE_MS = 450;
// The undo recorder folds edits into history on a 300 ms trailing debounce (useAnalyzerHistory); an undo
// issued inside that window would step over the wrong entry.
const HISTORY_SETTLE_MS = 350;

const MAX_SEARCH_RESULTS = 15;
const MAX_MY_RESULTS = 30;

// One experiment as the search / list tools report it: enough to name it, link it and tell its kind.
function compactExp(id: string, d: ExperimentDoc) {
  const kind = d.sourceType ?? 'unknown';
  return {
    id,
    title: d.displayName ?? null,
    subject: d.subject ?? null,
    kind,
    ...(kind === ExperimentType.Photos
      ? { photoCount: d.photoCount ?? null }
      : { durationSec: typeof d.duration === 'number' ? Number(d.duration.toFixed(1)) : null }),
    author: d.author || null,
  };
}

const round3 = (n: number) => Number(n.toFixed(3));
const inUnit = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

export interface ToolResult {
  content: string; // the tool_result content sent back to the model
  isError?: boolean;
}

const err = (content: string): ToolResult => ({ content, isError: true });
const ok = (payload: Record<string, unknown>): ToolResult => ({ content: JSON.stringify({ ok: true, ...payload }) });
const NO_EXPERIMENT = 'No experiment is open in the analyzer — open one first.';
const NO_PLAYER = 'No player is active — open an experiment in the analyzer first.';

/**
 * Execute a Lab Assistant tool in the browser and return its tool_result content (a string) for the
 * agent loop to send back to the model. Never throws — failures come back as { isError: true } results
 * so the model can read the error and recover.
 */
export async function executeAgentTool(
  name: string,
  input: Record<string, unknown>,
  deps: { navigate: NavigateFunction },
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'search_experiments': {
        const q = String(input.query ?? '')
          .trim()
          .toLowerCase();
        if (!q) return err('Provide a non-empty query.');
        // All public, non-trashed experiments — system showcases AND user-published ones (broader
        // than the homepage, which shows only the staff-featured subset). Firestore can't do
        // substring search, so filter by title / subject / description / author client-side.
        const snap = await getDocs(
          query(
            collection(firebaseDatabase, 'experiments'),
            where('visibility', '==', 'public'),
            where('trash', '==', false),
            orderBy('createdAt', 'desc'),
          ),
        );
        const results = snap.docs
          .map((d) => ({ id: d.id, d: d.data() as ExperimentDoc }))
          .filter(({ d }) =>
            `${d.displayName ?? ''} ${d.subject ?? ''} ${d.description ?? ''} ${d.author ?? ''}`
              .toLowerCase()
              .includes(q),
          )
          .slice(0, MAX_SEARCH_RESULTS)
          .map(({ id, d }) => compactExp(id, d));
        return { content: JSON.stringify({ count: results.length, results }) };
      }
      case 'list_my_experiments': {
        const user = useCommonStore.getState().user;
        if (!user) return err('No signed-in user.');
        const snap = await getDocs(
          query(
            collection(firebaseDatabase, 'experiments'),
            where('ownerId', '==', user.id),
            where('trash', '==', false),
          ),
        );
        const results = snap.docs
          .map((d) => ({ id: d.id, d: d.data() as ExperimentDoc }))
          .sort((a, b) => (b.d.createdAt?.toMillis() ?? 0) - (a.d.createdAt?.toMillis() ?? 0))
          .slice(0, MAX_MY_RESULTS)
          .map(({ id, d }) => compactExp(id, d));
        return { content: JSON.stringify({ count: results.length, results }) };
      }
      case 'open_experiment': {
        const expId = String(input.expId ?? '').trim();
        if (!expId) return err('Provide an expId.');
        const snap = await getDoc(doc(firebaseDatabase, `experiments/${expId}`));
        if (!snap.exists()) return err(`No experiment with id ${expId}.`);
        const d = snap.data() as ExperimentDoc;
        deps.navigate(`/experiments/${expId}`);
        return ok({ opened: compactExp(expId, d) });
      }
      case 'list_thermometers': {
        const ctx = buildAgentContext();
        if (!ctx.experimentOpen) return err(NO_EXPERIMENT);
        return {
          content: JSON.stringify({
            count: ctx.thermometers.length,
            thermometers: ctx.thermometers,
            temperatureUnit: ctx.temperatureUnit,
          }),
        };
      }
      case 'read_experiment_data': {
        const expId = String(input.expId ?? openExperimentId() ?? '').trim();
        if (!expId) return err('No experiment specified or open.');
        // Every kind is read server-side: a recording's .dat frames, a video's .vir bundle, a photo set
        // on its photo axis — the same summary + derived analysis the report and the Q&A are given.
        const { summary, analysis, title, sourceType, photoCount } = await getExperimentData(expId);
        return {
          content: JSON.stringify({
            expId,
            title,
            kind: sourceType,
            ...(sourceType === ExperimentType.Photos ? { photoCount: photoCount ?? null } : {}),
            summary,
            analysis,
          }),
        };
      }
      case 'add_thermometer': {
        const ctrl = playerRegistry.controller;
        if (!ctrl) return err(NO_PLAYER);
        const x = Number(input.x);
        const y = Number(input.y);
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
          return err('x and y must be in [0,1] (x left→right, y top→bottom; 0.5,0.5 is the centre).');
        }
        const areaType = typeof input.areaType === 'string' ? input.areaType.toLowerCase() : undefined;
        const id = await ctrl.addThermometer(x, y, areaType);
        const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
        if (name && id) useCommonStore.getState().updateThermometer(id, { name });
        const t = id ? useCommonStore.getState().thermometerMap.get(id) : undefined;
        return ok({
          added: {
            label: labelForId(id),
            name: name ?? null,
            x,
            y,
            areaType: areaType ?? 'point',
            aiPlaced: true,
            reading: t && Number.isFinite(t.value) ? Number(t.value.toFixed(1)) : null,
          },
        });
      }
      case 'rename_thermometer': {
        const r = resolveThermometer(String(input.thermometer ?? ''));
        if (!r) return err(`No thermometer matching “${input.thermometer}”.`);
        const name = String(input.name ?? '').trim();
        if (!name) return err('Provide a non-empty name.');
        useCommonStore.getState().updateThermometer(r.id, { name });
        return ok({ renamed: r.label, name });
      }
      case 'select_thermometer': {
        const r = resolveThermometer(String(input.thermometer ?? ''));
        if (!r) return err(`No thermometer matching “${input.thermometer}”.`);
        useCommonStore.getState().selectThermometer(r.id);
        return ok({ selected: r.label });
      }
      case 'remove_thermometer': {
        const expId = openExperimentId();
        if (!expId) return err(NO_EXPERIMENT);
        const r = resolveThermometer(String(input.thermometer ?? ''));
        if (!r) return err(`No thermometer matching “${input.thermometer}”.`);
        if (!(await confirmAction(`Delete thermometer ${r.label}?`))) {
          return { content: `The user declined to delete ${r.label}.` };
        }
        useCommonStore.getState().removeThermometer(expId, r.id);
        return ok({ removed: r.label });
      }
      case 'remove_all_thermometers': {
        const expId = openExperimentId();
        if (!expId) return err(NO_EXPERIMENT);
        const count = (useCommonStore.getState().experimentMap.get(expId)?.thermometersId ?? []).length;
        if (!count) return { content: 'There are no thermometers to remove.' };
        if (!(await confirmAction(`Delete all ${count} thermometer(s)?`))) {
          return { content: 'The user declined to delete all thermometers.' };
        }
        useCommonStore.getState().removeAllThermometers(expId);
        return ok({ removed: count });
      }
      case 'set_temperature_unit': {
        const want = String(input.unit ?? '').toLowerCase();
        if (want !== 'celsius' && want !== 'fahrenheit') {
          return err('unit must be "celsius" or "fahrenheit".');
        }
        const state = useCommonStore.getState();
        if (state.temperatureUnit !== want) state.toggleTemperatureUnit();
        return ok({ temperatureUnit: want });
      }
      case 'seek_to_time': {
        const ctrl = playerRegistry.controller;
        const open = openExperiment();
        if (!ctrl || !open) return err(NO_PLAYER);
        const value = Number(input.seconds);
        if (!Number.isFinite(value) || value < 0) {
          return err('seconds must be a non-negative number.');
        }
        if (isPhotoSet(open.exp)) {
          // The controller counts places from 0; the model (and the app's caption) count photos from 1.
          const photo = Math.max(1, Math.round(value));
          const count = ctrl.getPlayhead().lastFrameIndex + 1;
          if (photo > count) return err(`This set has ${count} photo(s); there is no photo ${photo}.`);
          ctrl.seekToTime(photo - 1);
          return ok({ photo, photoCount: count });
        }
        ctrl.seekToTime(value);
        return ok({ playhead: ctrl.getPlayhead() });
      }
      case 'set_playback': {
        const ctrl = playerRegistry.controller;
        if (!ctrl) return err(NO_PLAYER);
        const playing = input.playing === true || String(input.playing).toLowerCase() === 'true';
        ctrl.setPlaying(playing);
        return ok({ playing });
      }
      case 'navigate_to': {
        const page = String(input.page ?? '')
          .trim()
          .toLowerCase();
        // The profile route embeds the signed-in user's id, so it can't live in the static map.
        if (page === 'my_profile' || page === 'profile') {
          const user = useCommonStore.getState().user;
          if (!user) return err('Not signed in — there is no profile page to open.');
          const route = `/users/${user.id}`;
          deps.navigate(route);
          // The route is not echoed back: tool results become transcript that is sent to the
          // AI provider, and the route contains the account id (see buildAgentContext's page).
          return ok({ page: 'my_profile' });
        }
        const route = PAGE_ROUTES[page];
        if (!route) {
          return err(
            `Unknown page “${input.page}”. Known pages: ${[...Object.keys(PAGE_ROUTES), 'my_profile'].join(', ')}.`,
          );
        }
        deps.navigate(route);
        return ok({ page, route });
      }
      case 'list_annotations': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return err(NO_EXPERIMENT);
        const annotations = ctrl
          .list()
          .map((a, i) => ({ label: `A${i + 1}`, note: a.note, x: a.x, y: a.y, time: a.time }));
        return { content: JSON.stringify({ count: annotations.length, annotations }) };
      }
      case 'add_annotation': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return err(NO_EXPERIMENT);
        const note = String(input.note ?? '').trim();
        if (!note) return err('Provide the annotation text (note).');
        const x = input.x != null ? Number(input.x) : 0.5;
        const y = input.y != null ? Number(input.y) : 0.4;
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return err('x and y must be in [0,1].');
        const startSec = input.startSec != null ? Number(input.startSec) : undefined;
        const endSec = input.endSec != null ? Number(input.endSec) : undefined;
        const id = await ctrl.add({ x, y, note, startSec, endSec });
        if (!id) return err('Could not add the annotation.');
        // Own experiment → saved to the source; otherwise it's a local sandbox note (not uploaded).
        const open = openExperiment();
        const persisted = !!open && isOwnerOf(open.exp);
        const label = `A${ctrl.list().findIndex((a) => a.id === id) + 1}`;
        return ok({ added: { label, note, x, y }, persisted });
      }
      case 'edit_annotation': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return err(NO_EXPERIMENT);
        const r = resolveAnnotation(String(input.annotation ?? ''));
        if (!r) return err(`No annotation matching “${input.annotation}”.`);
        const fields: { note?: string; x?: number; y?: number; startSec?: number; endSec?: number } = {};
        if (input.note != null) fields.note = String(input.note);
        if (input.x != null) fields.x = Number(input.x);
        if (input.y != null) fields.y = Number(input.y);
        if (input.startSec != null) fields.startSec = Number(input.startSec);
        if (input.endSec != null) fields.endSec = Number(input.endSec);
        if (Object.keys(fields).length === 0) {
          return err('Nothing to change — provide note, x, y, startSec, or endSec.');
        }
        const done = ctrl.update(r.id, fields);
        return done ? ok({ edited: r.label }) : err(`Could not edit ${r.label}.`);
      }
      case 'remove_annotation': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return err(NO_EXPERIMENT);
        const r = resolveAnnotation(String(input.annotation ?? ''));
        if (!r) return err(`No annotation matching “${input.annotation}”.`);
        if (!(await confirmAction(`Delete annotation ${r.label} (“${r.note}”)?`))) {
          return { content: `The user declined to delete ${r.label}.` };
        }
        ctrl.remove(r.id);
        return ok({ removed: r.label });
      }

      // --- Profile lines (T(l) transects) ---------------------------------------------------------
      case 'list_profile_lines': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const lines = ctxProfileLines(open.exp);
        return { content: JSON.stringify({ count: lines.length, max: MAX_PROFILE_LINES, profileLines: lines }) };
      }
      case 'add_profile_line': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const existing = open.exp.profileLines ?? [];
        if (existing.length >= MAX_PROFILE_LINES) {
          return err(
            `This experiment already has the maximum of ${MAX_PROFILE_LINES} profile lines — remove one first.`,
          );
        }
        const given = [input.x1, input.y1, input.x2, input.y2];
        const provided = given.filter((v) => v != null).length;
        let endpoints: { x1: number; y1: number; x2: number; y2: number } | undefined;
        if (provided > 0) {
          if (provided < 4)
            return err('Give all four endpoint coordinates (x1, y1, x2, y2), or none for a default line.');
          const [x1, y1, x2, y2] = given.map(Number);
          if (![x1, y1, x2, y2].every(inUnit)) return err('Endpoints must be in [0,1] (x left→right, y top→bottom).');
          if (Math.hypot(x2 - x1, y2 - y1) < MIN_PROFILE_LENGTH) {
            return err(
              `The line is too short — its endpoints must be at least ${MIN_PROFILE_LENGTH} of the frame apart.`,
            );
          }
          endpoints = { x1, y1, x2, y2 };
        }
        const store = useCommonStore.getState();
        const before = new Set(existing.map((l) => l.id));
        store.addProfileLine(open.id, endpoints);
        const after = useCommonStore.getState().experimentMap.get(open.id)?.profileLines ?? [];
        const line = after.find((l) => !before.has(l.id));
        if (!line) return err('Could not add the profile line.');
        const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
        const lengthCm = input.lengthCm != null ? Number(input.lengthCm) : undefined;
        if (name || (lengthCm != null && Number.isFinite(lengthCm) && lengthCm > 0)) {
          useCommonStore.getState().updateProfileLine(open.id, {
            ...line,
            ...(name ? { name } : {}),
            ...(lengthCm != null && Number.isFinite(lengthCm) && lengthCm > 0 ? { lengthCm } : {}),
          });
        }
        const label = profileLabelForId(line.id);
        return ok({
          added: {
            label,
            name: name ?? null,
            x1: round3(line.x1),
            y1: round3(line.y1),
            x2: round3(line.x2),
            y2: round3(line.y2),
            lengthCm: lengthCm != null && Number.isFinite(lengthCm) && lengthCm > 0 ? lengthCm : null,
          },
          selected: true,
          // The owner's lines auto-save to the experiment; a viewer's ride in the session only.
          persisted: isOwnerOf(open.exp),
        });
      }
      case 'rename_profile_line': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const r = resolveProfileLine(String(input.line ?? ''));
        if (!r) return err(`No profile line matching “${input.line}”.`);
        const name = input.name != null ? String(input.name).trim() : undefined;
        const lengthRaw = input.lengthCm != null ? Number(input.lengthCm) : undefined;
        if (name === undefined && lengthRaw === undefined)
          return err('Nothing to change — provide name and/or lengthCm.');
        if (lengthRaw !== undefined && (!Number.isFinite(lengthRaw) || lengthRaw < 0)) {
          return err('lengthCm must be a non-negative number (0 clears the calibration).');
        }
        const store = useCommonStore.getState();
        if (name !== undefined) store.renameProfileLine(open.id, r.line.id, name || undefined);
        if (lengthRaw !== undefined) {
          const current = useCommonStore
            .getState()
            .experimentMap.get(open.id)
            ?.profileLines?.find((l) => l.id === r.line.id);
          if (current) {
            // 0 clears the calibration: drop the key rather than store 0 (an uncalibrated line has none).
            const next: ProfileLine = { ...current };
            if (lengthRaw > 0) next.lengthCm = lengthRaw;
            else delete next.lengthCm;
            useCommonStore.getState().updateProfileLine(open.id, next);
          }
        }
        return ok({
          line: r.label,
          ...(name !== undefined ? { name: name || null } : {}),
          ...(lengthRaw !== undefined ? { lengthCm: lengthRaw > 0 ? lengthRaw : null } : {}),
        });
      }
      case 'select_profile_line': {
        const r = resolveProfileLine(String(input.line ?? ''));
        if (!r) return err(`No profile line matching “${input.line}”.`);
        useCommonStore.getState().selectProfileLine(r.line.id);
        return ok({ selected: r.label });
      }
      case 'remove_profile_line': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const r = resolveProfileLine(String(input.line ?? ''));
        if (!r) return err(`No profile line matching “${input.line}”.`);
        if (!(await confirmAction(`Delete profile line ${r.label}?`))) {
          return { content: `The user declined to delete ${r.label}.` };
        }
        useCommonStore.getState().removeProfileLine(open.id, r.line.id);
        return ok({ removed: r.label });
      }
      case 'remove_all_profile_lines': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const count = (open.exp.profileLines ?? []).length;
        if (!count) return { content: 'There are no profile lines to remove.' };
        if (!(await confirmAction(`Delete all ${count} profile line(s)?`))) {
          return { content: 'The user declined to delete all profile lines.' };
        }
        useCommonStore.getState().removeAllProfileLines(open.id);
        return ok({ removed: count });
      }

      // --- Key moments ----------------------------------------------------------------------------
      case 'list_key_moments': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        if (isPhotoSet(open.exp)) return err('A photo set has no timeline, so it has no key moments.');
        const keyMoments = ctxKeyMoments(open.id, open.exp);
        return { content: JSON.stringify({ count: keyMoments.length, max: MAX_KEY_MOMENTS, keyMoments }) };
      }
      case 'add_key_moment': {
        const open = openExperiment();
        const ctrl = playerRegistry.controller;
        if (!open || !ctrl) return err(NO_PLAYER);
        if (isPhotoSet(open.exp)) return err('A photo set has no timeline, so key moments cannot be marked on it.');
        if (!isOwnerOf(open.exp)) return err("Only the experiment's owner can mark key moments.");
        const seconds = Number(input.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) return err('seconds must be a non-negative number.');
        const endSeconds = input.endSeconds != null ? Number(input.endSeconds) : undefined;
        if (endSeconds !== undefined && (!Number.isFinite(endSeconds) || endSeconds <= seconds)) {
          return err('endSeconds must be a number greater than seconds.');
        }
        const store = useCommonStore;
        if (store.getState().keyMoments.length >= MAX_KEY_MOMENTS) {
          return err(`This experiment already has the maximum of ${MAX_KEY_MOMENTS} key moments — remove one first.`);
        }
        const before = new Set(store.getState().keyMoments.map((m) => m.recordingIndex));
        // The player snapshots its CURRENT frame (the same path as the Info tab's "Mark this frame"), so
        // seek there first, let the frame land, then ask for the mark. A range is the app's two-step
        // gesture: mark the start, move to the end, mark the end.
        ctrl.seekToTime(seconds);
        await sleep(FRAME_SETTLE_MS);
        if (endSeconds !== undefined) {
          store.getState().requestSnapshotMoment('spanStart');
          if (!store.getState().pendingSpanStart) return err('The player did not accept the start of the range.');
          ctrl.seekToTime(endSeconds);
          await sleep(FRAME_SETTLE_MS);
          store.getState().requestSnapshotMoment('spanEnd');
          if (store.getState().pendingSpanStart) {
            store.getState().setPendingSpanStart(null);
            return err('The end of the range must fall on a later frame than its start.');
          }
        } else {
          store.getState().requestSnapshotMoment('keyMoment');
        }
        const list = store.getState().keyMoments;
        // The new entry is the one not there before; re-marking an existing frame replaces it, in which
        // case fall back to the moment nearest the requested time.
        let added = list.find((m) => !before.has(m.recordingIndex));
        if (!added && list.length) {
          added = list.reduce((best, m) =>
            Math.abs(m.tSeconds - seconds) < Math.abs(best.tSeconds - seconds) ? m : best,
          );
        }
        if (!added) return err('The player did not mark the moment.');
        const addedIndex = added.recordingIndex;
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (text) store.getState().setKeyMomentText(addedIndex, text);
        const sorted = keyMomentsOf(open.id, open.exp);
        const idx = sorted.findIndex((m) => m.recordingIndex === addedIndex);
        return ok({
          added: {
            label: `K${idx + 1}`,
            seconds: added.tSeconds,
            ...(typeof added.endTSeconds === 'number' ? { endSeconds: added.endTSeconds } : {}),
            text: text || null,
          },
        });
      }
      case 'edit_key_moment': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        if (!isOwnerOf(open.exp)) return err("Only the experiment's owner can edit key moments.");
        const r = resolveKeyMoment(String(input.moment ?? ''));
        if (!r) return err(`No key moment matching “${input.moment}”.`);
        const text = String(input.text ?? '').trim();
        useCommonStore.getState().setKeyMomentText(r.moment.recordingIndex, text);
        return ok({ edited: r.label, text: text || null });
      }
      case 'remove_key_moment': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        if (!isOwnerOf(open.exp)) return err("Only the experiment's owner can remove key moments.");
        const r = resolveKeyMoment(String(input.moment ?? ''));
        if (!r) return err(`No key moment matching “${input.moment}”.`);
        const caption = r.moment.text?.trim() ? ` (“${r.moment.text.trim()}”)` : '';
        if (!(await confirmAction(`Delete key moment ${r.label} at ${r.moment.tSeconds} s${caption}?`))) {
          return { content: `The user declined to delete ${r.label}.` };
        }
        useCommonStore.getState().removeKeyMoment(r.moment.recordingIndex);
        return ok({ removed: r.label });
      }

      // --- Charts, overlays and the workspace --------------------------------------------------------
      case 'toggle_chart': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const chart = resolveChart(input.chart);
        if (!chart) return err('chart must be one of T(t), T(x), T(y), T(l), N(T).');
        const on = input.on === true || String(input.on).toLowerCase() === 'true';
        const options = open.exp.graphsOptions ?? [];
        const has = options.includes(chart.option);
        const store = useCommonStore.getState();
        if (on && !has) {
          if (chart.option === ExperimentGraphOption.time && isPhotoSet(open.exp)) {
            return err('A photo set has no time axis, so T(t) is not available on it.');
          }
          if (visibleChartCount(options) >= MAX_VISIBLE_CHARTS) {
            return err(`At most ${MAX_VISIBLE_CHARTS} charts show at once — hide one first.`);
          }
          store.toggleGraphOption(open.id, chart.option);
        } else if (!on && has) {
          store.toggleGraphOption(open.id, chart.option);
        }
        store.setWorkspaceMode('charts');
        const now = useCommonStore.getState().experimentMap.get(open.id)?.graphsOptions ?? [];
        return ok({
          chart: chart.name,
          on,
          chartsOn: now.filter((o) => CHART_GRAPH_OPTIONS.includes(o)).flatMap((o) => nameOfOption(o) ?? []),
        });
      }
      case 'maximize_chart': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const raw = String(input.chart ?? '')
          .trim()
          .toLowerCase();
        const store = useCommonStore.getState();
        if (raw === 'none' || raw === '') {
          store.setMaximizedChart(null);
          store.setWorkspaceMode('charts');
          return ok({ maximized: null });
        }
        const chart = resolveChart(input.chart);
        if (!chart) return err('chart must be one of T(t), T(x), T(y), T(l), N(T), or none.');
        const options = open.exp.graphsOptions ?? [];
        if (!options.includes(chart.option)) {
          if (chart.option === ExperimentGraphOption.time && isPhotoSet(open.exp)) {
            return err('A photo set has no time axis, so T(t) is not available on it.');
          }
          if (visibleChartCount(options) >= MAX_VISIBLE_CHARTS) {
            return err(
              `${chart.name} is not shown and at most ${MAX_VISIBLE_CHARTS} charts show at once — hide one first.`,
            );
          }
          store.toggleGraphOption(open.id, chart.option);
        }
        useCommonStore.getState().setMaximizedChart(chart.option);
        useCommonStore.getState().setWorkspaceMode('charts');
        return ok({ maximized: chart.name });
      }
      case 'toggle_overlay': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const overlay = resolveOverlay(input.overlay);
        if (!overlay) return err('overlay must be one of isotherms, scale_bar, hotspots, diff.');
        const on = input.on === true || String(input.on).toLowerCase() === 'true';
        const has = (open.exp.graphsOptions ?? []).includes(overlay.option);
        if (on !== has) useCommonStore.getState().toggleGraphOption(open.id, overlay.option);
        const now = useCommonStore.getState().experimentMap.get(open.id)?.graphsOptions ?? [];
        return ok({
          overlay: overlay.name,
          on,
          overlaysOn: now.filter((o) => !CHART_GRAPH_OPTIONS.includes(o)).flatMap((o) => nameOfOption(o) ?? []),
        });
      }
      case 'set_isotherm_levels': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const auto = input.auto === true || String(input.auto).toLowerCase() === 'true';
        const store = useCommonStore.getState();
        let lockedLevels: number[] | null = null;
        if (!auto) {
          const raw = Array.isArray(input.levels) ? input.levels : [];
          const levels = [...new Set(raw.map(Number).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
          if (levels.length < 1 || levels.length > 8) {
            return err('Give 1–8 contour temperatures in °C in `levels`, or auto: true.');
          }
          lockedLevels = levels;
        }
        store.setIsothermSetting(open.id, { lockedLevels });
        if (!(open.exp.graphsOptions ?? []).includes(ExperimentGraphOption.isotherm)) {
          useCommonStore.getState().toggleGraphOption(open.id, ExperimentGraphOption.isotherm);
        }
        return ok({ isotherms: 'on', levelsC: lockedLevels ?? 'auto' });
      }
      case 'show_workspace_tab': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const key = String(input.tab ?? '')
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
        const mode =
          TAB_BY_NAME[key] ??
          (key === 'askai' ? 'askAI' : key === 'aireport' ? 'aiReport' : key === 'twin' ? 'twin' : undefined);
        if (!mode) return err('tab must be one of info, charts, ask_ai, ai_report, digital_twin.');
        const why = tabAvailable(mode, open.exp);
        if (why) return err(why);
        useCommonStore.getState().setWorkspaceMode(mode);
        return ok({ tab: nameOfTab(mode) });
      }
      case 'undo_redo': {
        const open = openExperiment();
        if (!open) return err(NO_EXPERIMENT);
        const action = String(input.action ?? '')
          .trim()
          .toLowerCase();
        if (action !== 'undo' && action !== 'redo') return err('action must be "undo" or "redo".');
        await sleep(HISTORY_SETTLE_MS);
        const h = useCommonStore.getState().analyzerHistory;
        if (h.expId !== open.id || !h.present) return { content: 'There is no edit history for this experiment yet.' };
        if (action === 'undo' && h.past.length === 0) return { content: 'Nothing to undo.' };
        if (action === 'redo' && h.future.length === 0) return { content: 'Nothing to redo.' };
        if (action === 'undo') useCommonStore.getState().undoAnalyzer();
        else useCommonStore.getState().redoAnalyzer();
        const after = useCommonStore.getState().analyzerHistory;
        return ok({ action, remaining: { undo: after.past.length, redo: after.future.length } });
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const code = (e as { code?: string })?.code;
    const message = (e as { message?: string })?.message ?? 'tool failed';
    return err(`Error running ${name}: ${code ? `${code} — ` : ''}${message}`);
  }
}
