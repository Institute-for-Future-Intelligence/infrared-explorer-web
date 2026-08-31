import type { NavigateFunction } from 'react-router-dom';
import { Modal } from 'antd';
import { collection, doc, getDoc, getDocs, orderBy, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../../services/firebase';
import { getExperimentData } from '../../services/ai';
import useCommonStore from '../../stores/common';
import { Experiment, ExperimentDoc, ExperimentType, Thermometer } from '../../types';
import { playerRegistry } from './playerRegistry';
import { annotationRegistry } from './annotationRegistry';
import { getThermometerValue } from '../../utils/temperatureReader';
import { getDecodedFrame } from '../../utils/thermalFrame';
import { AI_FRAME_SAMPLES, IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../utils/constants';

// The client half of the Lab Assistant's tools: execution + the app-state snapshot the model is given.
// The tool SCHEMAS are authoritative server-side (functions/src/index.ts AGENT_TOOLS) — keep names in
// sync. v1 tools are read-only + navigation: search / list / open experiments, list thermometers, read
// thermal data (that last one delegates its heavy read to the getExperimentData callable).

// A thermometer as reported to the model.
interface CtxThermometer {
  label: string; // positional T1, T2, … (index in the experiment's thermometersId)
  name: string | null;
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

export interface AgentContext {
  page: string; // route path, e.g. '/experiments/abc' or '/home'
  experimentOpen: boolean;
  experiment: {
    id: string;
    title: string | null;
    subject: string | null;
    sourceType: string;
    duration: number;
  } | null;
  thermometers: CtxThermometer[];
  annotations: CtxAnnotation[];
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

/** Build the app-state snapshot injected into the model each turn (what's open, its thermometers, unit). */
export function buildAgentContext(): AgentContext {
  const state = useCommonStore.getState();
  const expId = openExperimentId();
  const exp = expId ? state.experimentMap.get(expId) : undefined;
  const thermometers: CtxThermometer[] = exp
    ? (exp.thermometersId ?? [])
        .map((id, i): CtxThermometer | null => {
          const t = state.thermometerMap.get(id);
          if (!t) return null;
          return {
            label: `T${i + 1}`,
            name: t.name || null,
            x: Number(t.x.toFixed(3)),
            y: Number(t.y.toFixed(3)),
            areaType: t.measuringAreaType ?? 'point',
            reading: Number.isFinite(t.value) ? Number(t.value.toFixed(1)) : null,
            unit: t.unit ?? state.temperatureUnit,
          };
        })
        .filter((x): x is CtxThermometer => x !== null)
    : [];
  return {
    page: currentPath(),
    experimentOpen: !!exp,
    experiment:
      exp && expId
        ? {
            id: expId,
            title: exp.displayName ?? null,
            subject: exp.subject ?? null,
            sourceType: exp.sourceType ?? 'unknown',
            duration: exp.duration ?? 0,
          }
        : null,
    thermometers,
    annotations:
      annotationRegistry.controller
        ?.list()
        .map((a, i) => ({ label: `A${i + 1}`, note: a.note, x: a.x, y: a.y, time: a.time })) ?? [],
    temperatureUnit: state.temperatureUnit,
  };
}

/** Tool names usable given the current context. Search / navigation / data tools are always available;
 *  the thermometer + unit tools when an experiment is open; placing a thermometer / driving playback
 *  need the live ImagePlayer (recording experiments only). */
export function enabledToolsFor(ctx: AgentContext): string[] {
  const tools = ['search_experiments', 'list_my_experiments', 'open_experiment', 'navigate_to', 'read_experiment_data'];
  if (ctx.experimentOpen) {
    tools.push(
      'list_thermometers',
      'rename_thermometer',
      'select_thermometer',
      'remove_thermometer',
      'remove_all_thermometers',
      'set_temperature_unit',
    );
  }
  if (playerRegistry.controller) {
    tools.push('add_thermometer', 'seek_to_time', 'set_playback');
  }
  // The annotation overlay is present whenever an experiment is open in the analyzer (recording or video).
  if (annotationRegistry.controller) {
    tools.push('list_annotations', 'add_annotation', 'edit_annotation', 'remove_annotation');
  }
  return tools;
}

// Top-level app pages the assistant can navigate to (navigate_to tool). Aliases map to the same route.
// 'my_profile' / 'profile' are resolved dynamically in the handler (the route carries the user's id).
const PAGE_ROUTES: Record<string, string> = {
  home: '/',
  gallery: '/',
  me: '/me',
  my_experiments: '/myExperimentsList',
  recent: '/recent',
  history: '/recent',
  raw: '/raw',
  classroom: '/classroom',
  trash: '/trash',
  settings: '/settings',
  about: '/about',
  contact: '/contact',
  admin_users: '/admin/users',
  admin_experiments: '/admin/experiments',
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

const MAX_SEARCH_RESULTS = 15;
const MAX_MY_RESULTS = 30;

function compactExp(id: string, d: ExperimentDoc) {
  return { id, title: d.displayName ?? null, subject: d.subject ?? null };
}

// AI-summary frame budget for a video (mirrors the server's REPORT_FRAME_SAMPLES). Deliberately far below
// the user-facing chart cap (LINEPLOT_POINTS_VIDEO): this set is serialised into the prompt, so it is
// cost-bound, not raised in lockstep with the charts. See AI_FRAME_SAMPLES.
const VIDEO_FRAME_SAMPLES = AI_FRAME_SAMPLES;
const round2 = (n: number) => Number(n.toFixed(2));
const round3 = (n: number) => Number(n.toFixed(3));

// Whole-frame min/max/mean + hottest-pixel location for one video thermal frame. Mirrors the server's
// frameStats (functions/src/thermal.ts) so both experiment kinds hand the model the same shape.
function frameStatsClient(frame: ArrayBufferLike) {
  // The shared frame cache computes min/max/mean + the hottest-pixel index in its single decode pass.
  const { min, max, mean, maxIdx } = getDecodedFrame(frame);
  return {
    min: round2(min),
    max: round2(max),
    mean: round2(mean),
    hotspot: {
      x: round3(((maxIdx % IR_ARRAY_WIDTH) + 0.5) / IR_ARRAY_WIDTH),
      y: round3((Math.floor(maxIdx / IR_ARRAY_WIDTH) + 0.5) / IR_ARRAY_HEIGHT),
    },
  };
}

/**
 * Build the SAME thermal summary shape as the server's buildThermalSummary, but for a VIDEO experiment,
 * entirely client-side: a video's per-frame thermal data is a `.vir` bundle the server can't decode, yet
 * the analyzer has already parsed it into showcaseThermalCache when the experiment is open. Returns null
 * if the data (or its thermometers) hasn't loaded yet.
 */
function buildVideoThermalSummary(expId: string, exp: Experiment): unknown | null {
  const state = useCommonStore.getState();
  const frames = state.showcaseThermalCache.get(expId);
  if (!frames || frames.length === 0) return null;
  const frameCount = frames.length;
  const duration = Number(exp.duration) || 0;

  const thermometers = (exp.thermometersId ?? [])
    .map((id, i) => {
      const t = state.thermometerMap.get(id);
      return t ? { t, label: `T${i + 1}` } : null;
    })
    .filter((x): x is { t: Thermometer; label: string } => x !== null);

  // Sample up to VIDEO_FRAME_SAMPLES frames evenly across the clip, INCLUSIVE of the last frame — the
  // old `i += floor(frameCount / N)` stride stopped short and left the tail of the clip unsampled.
  const maxPoints = Math.min(VIDEO_FRAME_SAMPLES, frameCount);
  const lastIdx = frameCount - 1;
  const sampleIdx: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    sampleIdx.push(maxPoints === 1 ? 0 : Math.round((i * lastIdx) / (maxPoints - 1)));
  }

  const series = thermometers.map((t) => ({
    label: t.label,
    position: { x: round3(t.t.x), y: round3(t.t.y) },
    temps: [] as number[],
  }));
  // Shared time axis — series[i], times[i] and frameGlobal[i] describe the same instant. Kept identical
  // in shape to the server's buildThermalSummary / buildVideoThermalSummary so the three summaries the
  // report, the Q&A and this agent produce cannot drift apart.
  const times: number[] = [];
  const frameGlobal: { t: number; min: number; max: number; mean: number; hotspot: { x: number; y: number } }[] = [];
  for (const fi of sampleIdx) {
    const frame = frames[fi];
    if (!frame) continue;
    const tSec = Number((frameCount > 1 ? (fi / (frameCount - 1)) * duration : 0).toFixed(2));
    thermometers.forEach((t, ti) => series[ti].temps.push(getThermometerValue(frame, t.t)));
    times.push(tSec);
    frameGlobal.push({ t: tSec, ...frameStatsClient(frame) });
  }
  if (frameGlobal.length === 0) return null;

  const spannedSec = times[times.length - 1] - times[0];
  return {
    durationSec: duration,
    fps: duration > 0 ? round2(frameCount / duration) : null,
    requestedFrames: sampleIdx.length,
    sampledFrames: frameGlobal.length,
    subject: exp.subject ?? null,
    existingTitle: exp.displayName ?? '',
    existingDescription: exp.description ?? '',
    times,
    thermometers: series.map((s) => {
      const temps = s.temps;
      const start = temps[0] ?? null;
      const end = temps.length ? temps[temps.length - 1] : null;
      return {
        label: s.label,
        position: s.position,
        series: temps,
        min: temps.length ? Math.min(...temps) : null,
        max: temps.length ? Math.max(...temps) : null,
        startTemp: start,
        endTemp: end,
        changeC: start != null && end != null ? round2(end - start) : null,
        // First-to-last SECANT, not a fitted rate (see buildThermalSummary).
        secantCPerSec: start != null && end != null && spannedSec > 0 ? round3((end - start) / spannedSec) : null,
      };
    }),
    frameGlobal,
  };
}

export interface ToolResult {
  content: string; // the tool_result content sent back to the model
  isError?: boolean;
}

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
        if (!q) return { content: 'Provide a non-empty query.', isError: true };
        // All public, non-trashed experiments — system showcases AND user-published ones (broader
        // than the homepage, which shows only the staff-featured subset). Firestore can't do
        // substring search, so filter by title/subject client-side.
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
          .filter(({ d }) => `${d.displayName ?? ''} ${d.subject ?? ''}`.toLowerCase().includes(q))
          .slice(0, MAX_SEARCH_RESULTS)
          .map(({ id, d }) => compactExp(id, d));
        return { content: JSON.stringify({ count: results.length, results }) };
      }
      case 'list_my_experiments': {
        const user = useCommonStore.getState().user;
        if (!user) return { content: 'No signed-in user.', isError: true };
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
        if (!expId) return { content: 'Provide an expId.', isError: true };
        const snap = await getDoc(doc(firebaseDatabase, `experiments/${expId}`));
        if (!snap.exists()) return { content: `No experiment with id ${expId}.`, isError: true };
        const d = snap.data() as ExperimentDoc;
        deps.navigate(`/experiments/${expId}`);
        return { content: JSON.stringify({ ok: true, opened: compactExp(expId, d) }) };
      }
      case 'list_thermometers': {
        const ctx = buildAgentContext();
        if (!ctx.experimentOpen) return { content: 'No experiment is open in the analyzer.', isError: true };
        return {
          content: JSON.stringify({
            count: ctx.thermometers.length,
            thermometers: ctx.thermometers,
            temperatureUnit: ctx.temperatureUnit,
          }),
        };
      }
      case 'read_experiment_data': {
        const openId = openExperimentId();
        const expId = String(input.expId ?? openId ?? '').trim();
        if (!expId) return { content: 'No experiment specified or open.', isError: true };
        // Video experiments have no server-side .dat frames (their thermal data is a client-parsed .vir
        // bundle), so build the summary locally from the loaded frames when the open experiment is a
        // video; otherwise (recording, or an experiment that isn't open) read it server-side.
        const openExp = openId && expId === openId ? useCommonStore.getState().experimentMap.get(expId) : undefined;
        if (openExp && openExp.sourceType === ExperimentType.Video) {
          const summary = buildVideoThermalSummary(expId, openExp);
          if (!summary) {
            return {
              content: 'The video experiment’s thermal data is still loading — ask again in a moment.',
              isError: true,
            };
          }
          return { content: JSON.stringify({ expId, title: openExp.displayName ?? null, summary }) };
        }
        const { summary, title } = await getExperimentData(expId);
        return { content: JSON.stringify({ expId, title, summary }) };
      }
      case 'add_thermometer': {
        const ctrl = playerRegistry.controller;
        if (!ctrl)
          return { content: 'No recording player is active — open a recording experiment first.', isError: true };
        const x = Number(input.x);
        const y = Number(input.y);
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
          return {
            content: 'x and y must be in [0,1] (x left→right, y top→bottom; 0.5,0.5 is the centre).',
            isError: true,
          };
        }
        const areaType = typeof input.areaType === 'string' ? input.areaType.toLowerCase() : undefined;
        const id = await ctrl.addThermometer(x, y, areaType);
        const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
        if (name && id) useCommonStore.getState().updateThermometer(id, { name });
        const t = id ? useCommonStore.getState().thermometerMap.get(id) : undefined;
        return {
          content: JSON.stringify({
            ok: true,
            added: {
              label: labelForId(id),
              name: name ?? null,
              x,
              y,
              areaType: areaType ?? 'point',
              reading: t && Number.isFinite(t.value) ? Number(t.value.toFixed(1)) : null,
            },
          }),
        };
      }
      case 'rename_thermometer': {
        const r = resolveThermometer(String(input.thermometer ?? ''));
        if (!r) return { content: `No thermometer matching “${input.thermometer}”.`, isError: true };
        const name = String(input.name ?? '').trim();
        if (!name) return { content: 'Provide a non-empty name.', isError: true };
        useCommonStore.getState().updateThermometer(r.id, { name });
        return { content: JSON.stringify({ ok: true, renamed: r.label, name }) };
      }
      case 'select_thermometer': {
        const r = resolveThermometer(String(input.thermometer ?? ''));
        if (!r) return { content: `No thermometer matching “${input.thermometer}”.`, isError: true };
        useCommonStore.getState().selectThermometer(r.id);
        return { content: JSON.stringify({ ok: true, selected: r.label }) };
      }
      case 'remove_thermometer': {
        const expId = openExperimentId();
        if (!expId) return { content: 'No experiment is open.', isError: true };
        const r = resolveThermometer(String(input.thermometer ?? ''));
        if (!r) return { content: `No thermometer matching “${input.thermometer}”.`, isError: true };
        if (!(await confirmAction(`Delete thermometer ${r.label}?`))) {
          return { content: `The user declined to delete ${r.label}.` };
        }
        useCommonStore.getState().removeThermometer(expId, r.id);
        return { content: JSON.stringify({ ok: true, removed: r.label }) };
      }
      case 'remove_all_thermometers': {
        const expId = openExperimentId();
        if (!expId) return { content: 'No experiment is open.', isError: true };
        const count = (useCommonStore.getState().experimentMap.get(expId)?.thermometersId ?? []).length;
        if (!count) return { content: 'There are no thermometers to remove.' };
        if (!(await confirmAction(`Delete all ${count} thermometer(s)?`))) {
          return { content: 'The user declined to delete all thermometers.' };
        }
        useCommonStore.getState().removeAllThermometers(expId);
        return { content: JSON.stringify({ ok: true, removed: count }) };
      }
      case 'set_temperature_unit': {
        const want = String(input.unit ?? '').toLowerCase();
        if (want !== 'celsius' && want !== 'fahrenheit') {
          return { content: 'unit must be "celsius" or "fahrenheit".', isError: true };
        }
        const state = useCommonStore.getState();
        if (state.temperatureUnit !== want) state.toggleTemperatureUnit();
        return { content: JSON.stringify({ ok: true, temperatureUnit: want }) };
      }
      case 'seek_to_time': {
        const ctrl = playerRegistry.controller;
        if (!ctrl) return { content: 'No recording player is active.', isError: true };
        const seconds = Number(input.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return { content: 'seconds must be a non-negative number.', isError: true };
        }
        ctrl.seekToTime(seconds);
        return { content: JSON.stringify({ ok: true, playhead: ctrl.getPlayhead() }) };
      }
      case 'set_playback': {
        const ctrl = playerRegistry.controller;
        if (!ctrl) return { content: 'No recording player is active.', isError: true };
        const playing = input.playing === true || String(input.playing).toLowerCase() === 'true';
        ctrl.setPlaying(playing);
        return { content: JSON.stringify({ ok: true, playing }) };
      }
      case 'navigate_to': {
        const page = String(input.page ?? '')
          .trim()
          .toLowerCase();
        // The profile route embeds the signed-in user's id, so it can't live in the static map.
        if (page === 'my_profile' || page === 'profile') {
          const user = useCommonStore.getState().user;
          if (!user) return { content: 'Not signed in — there is no profile page to open.', isError: true };
          const route = `/users/${user.id}`;
          deps.navigate(route);
          return { content: JSON.stringify({ ok: true, page: 'my_profile', route }) };
        }
        const route = PAGE_ROUTES[page];
        if (!route) {
          return {
            content: `Unknown page “${input.page}”. Known pages: ${[...Object.keys(PAGE_ROUTES), 'my_profile'].join(', ')}.`,
            isError: true,
          };
        }
        deps.navigate(route);
        return { content: JSON.stringify({ ok: true, page, route }) };
      }
      case 'list_annotations': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return { content: 'No experiment is open in the analyzer.', isError: true };
        const annotations = ctrl
          .list()
          .map((a, i) => ({ label: `A${i + 1}`, note: a.note, x: a.x, y: a.y, time: a.time }));
        return { content: JSON.stringify({ count: annotations.length, annotations }) };
      }
      case 'add_annotation': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return { content: 'No experiment is open in the analyzer.', isError: true };
        const note = String(input.note ?? '').trim();
        if (!note) return { content: 'Provide the annotation text (note).', isError: true };
        const x = input.x != null ? Number(input.x) : 0.5;
        const y = input.y != null ? Number(input.y) : 0.4;
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { content: 'x and y must be in [0,1].', isError: true };
        const startSec = input.startSec != null ? Number(input.startSec) : undefined;
        const endSec = input.endSec != null ? Number(input.endSec) : undefined;
        const id = await ctrl.add({ x, y, note, startSec, endSec });
        if (!id) return { content: 'Could not add the annotation.', isError: true };
        // Own experiment → saved to the source; otherwise it's a local sandbox note (not uploaded).
        const openId = openExperimentId();
        const exp = openId ? useCommonStore.getState().experimentMap.get(openId) : undefined;
        const user = useCommonStore.getState().user;
        const persisted = !!(exp && user && exp.ownerId === user.id);
        const label = `A${ctrl.list().findIndex((a) => a.id === id) + 1}`;
        return { content: JSON.stringify({ ok: true, added: { label, note, x, y }, persisted }) };
      }
      case 'edit_annotation': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return { content: 'No experiment is open in the analyzer.', isError: true };
        const r = resolveAnnotation(String(input.annotation ?? ''));
        if (!r) return { content: `No annotation matching “${input.annotation}”.`, isError: true };
        const fields: { note?: string; x?: number; y?: number; startSec?: number; endSec?: number } = {};
        if (input.note != null) fields.note = String(input.note);
        if (input.x != null) fields.x = Number(input.x);
        if (input.y != null) fields.y = Number(input.y);
        if (input.startSec != null) fields.startSec = Number(input.startSec);
        if (input.endSec != null) fields.endSec = Number(input.endSec);
        if (Object.keys(fields).length === 0) {
          return { content: 'Nothing to change — provide note, x, y, startSec, or endSec.', isError: true };
        }
        const ok = ctrl.update(r.id, fields);
        return ok
          ? { content: JSON.stringify({ ok: true, edited: r.label }) }
          : { content: `Could not edit ${r.label}.`, isError: true };
      }
      case 'remove_annotation': {
        const ctrl = annotationRegistry.controller;
        if (!ctrl) return { content: 'No experiment is open in the analyzer.', isError: true };
        const r = resolveAnnotation(String(input.annotation ?? ''));
        if (!r) return { content: `No annotation matching “${input.annotation}”.`, isError: true };
        if (!(await confirmAction(`Delete annotation ${r.label} (“${r.note}”)?`))) {
          return { content: `The user declined to delete ${r.label}.` };
        }
        ctrl.remove(r.id);
        return { content: JSON.stringify({ ok: true, removed: r.label }) };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const message = (err as { message?: string })?.message ?? 'tool failed';
    return { content: `Error running ${name}: ${code ? `${code} — ` : ''}${message}`, isError: true };
  }
}
