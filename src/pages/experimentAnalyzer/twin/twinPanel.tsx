/**
 * The "3D Twin" workspace tab (docs/digital-twin-plan.md §9–§11). Owner + staff: run the camera-motion
 * gate over the recording, send the stillest frame to the scene-analysis Function, and show the rebuilt
 * scene; everyone else: show what the owner built. The solver and the heat-map projection are cheap
 * and run here on every open; only the model's answer (twinScene) and the owner's corrections
 * (twinEdits) are persisted.
 *
 * Following the playhead: the layout is frozen at the analysed frame, but the paint follows whatever
 * frame the player shows, so heating and cooling play out on the 3D props. A similarity check against
 * the analysed frame warns when the scene no longer looks like the one the twin was built from.
 *
 * A generation outlives this panel: switching tabs must not cancel a 30-second run, so the work lives
 * in a module-level map keyed by experiment and writes its result into the store when it finishes; the
 * panel just subscribes to the progress while it is mounted.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Popconfirm, Segmented, Select, Slider, Switch, Tooltip } from 'antd';
import { AimOutlined, ClearOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import { getMetadata, ref } from 'firebase/storage';
import {
  Experiment,
  TwinEdits,
  TwinObjectEdit,
  TwinObjectKind,
  TwinSceneRecord,
  isTwinBuildingRecord,
} from '../../../types';
import useCommonStore from '../../../stores/common';
import { firebaseStorage } from '../../../services/firebase';
import { isStaff } from '../../../utils/staff';
import { analyzeTwinScene, clearTwinScene } from '../../../services/ai';
import { saveTwinEdits } from '../../../services/experiments';
import { fetchRecordingFrameBufferCached } from '../../../utils/recordingFrame';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import {
  MIN_NCC_SCORE,
  STABLE_MAX_SHIFT_PX,
  alignFrame,
  assessStability,
  frameSimilarity,
  highPass,
  stabilitySampleIndices,
  type ShiftEstimate,
} from '../../../utils/twinStability';
import {
  NOMINAL_SIZES,
  NON_RENDERED_KINDS,
  PITCH_DEG,
  TWIN_KIND_LIST,
  applyTwinEdits,
  solveTwinLayout,
} from '../../../utils/twinSolver';
import { ambientOutsideBoxes, plateauEqualization, type ThermalSource } from '../../../utils/twinThermal';
import type { TwinViewMode } from './twinScene3d';
import { kindLabel } from './props';

// three.js lives in this lazily-loaded chunk — it only downloads on first open of the tab.
const TwinScene3D = lazy(() => import('./twinScene3d'));

const RECORDING_FPS = 5;
/** Parallel Storage reads while sampling frames for the motion gate. */
const FETCH_POOL = 4;
/** How long the playhead must rest on a frame before the twin fetches it (scrubbing skips frames). */
const FOLLOW_DEBOUNCE_MS = 120;
/** Frames warmed ahead of the playhead while playing, so playback does not stall on fetches. */
const FOLLOW_PREFETCH = 3;
/** Below this similarity to the analysed frame the scene is probably rearranged (plan §11). */
const SCENE_CHANGED_BELOW = 0.45;
/** Owner corrections are saved this long after the last change. */
const EDIT_SAVE_DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------------------------------
// Generation runs, independent of the panel's lifetime.

interface Run {
  progress: string;
  error: string | null;
  done: boolean;
  listeners: Set<() => void>;
}
const runs = new Map<string, Run>();
const notify = (run: Run) => run.listeners.forEach((l) => l());

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The whole generation: motion gate → Function → store. Errors land in the run for the panel to show. */
function startRun(experiment: Experiment): Run {
  const existing = runs.get(experiment.id);
  if (existing && !existing.done) return existing;
  const run: Run = { progress: 'Starting…', error: null, done: false, listeners: new Set() };
  runs.set(experiment.id, run);
  useCommonStore.getState().setTwinRunningExpId(experiment.id);
  const set = (progress: string) => {
    run.progress = progress;
    notify(run);
  };
  (async () => {
    const recordingId = experiment.recordingId!;
    const frameCount = Math.max(1, Math.round(experiment.duration * RECORDING_FPS));
    const indices = stabilitySampleIndices(frameCount);
    let fetched = 0;
    set(`Checking camera motion… 0/${indices.length} frames`);
    const samples = await mapPool(indices, FETCH_POOL, async (index) => {
      try {
        const buf = await fetchRecordingFrameBufferCached(recordingId, index);
        const frame = getDecodedFrame(buf);
        return { index, temps: frame.temps };
      } catch {
        return null; // a missing frame just drops that sample
      } finally {
        fetched++;
        set(`Checking camera motion… ${fetched}/${indices.length} frames`);
      }
    });
    const valid = samples.filter((s): s is { index: number; temps: Float32Array } => !!s);
    if (!valid.length) throw new Error('No thermal frames could be read from this recording.');
    const stability = assessStability(valid, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
    if (!stability.stable) {
      throw new Error(
        `The camera moved too much for a 3D twin: the picture drifts ${stability.maxShiftPx} px from the stillest frame, and the twin can only correct up to ${STABLE_MAX_SHIFT_PX} px (about 4° of pan). Keep the phone still — a stand helps — and record again.`,
      );
    }
    set(
      `Camera steady enough (drift ≤ ${stability.maxShiftPx} px, corrected frame by frame). Analysing frame ${stability.referenceIndex} with the vision model…`,
    );
    const record = await analyzeTwinScene(experiment.id, stability.referenceIndex, stability);
    const store = useCommonStore.getState();
    const live = store.experimentMap.get(experiment.id);
    if (live) {
      // The server dropped the previous corrections with the previous scene (their object ids are gone).
      const { twinEdits: _stale, ...rest } = live;
      store.setExperiment(experiment.id, { ...rest, twinScene: record });
    }
  })()
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // A bare "internal" is the callable SDK's word for "the request never got an answer" — the
      // function is missing (an emulator running an older build) or unreachable — not a server verdict.
      run.error =
        msg === 'internal' || /^internal$/i.test(msg.trim())
          ? 'The analysis service could not be reached. If this is a local build against the Functions emulator, restart the emulator so it picks up analyzeTwinScene; otherwise check the network and try again.'
          : msg;
    })
    .finally(() => {
      run.done = true;
      const store = useCommonStore.getState();
      if (store.twinRunningExpId === experiment.id) store.setTwinRunningExpId(null);
      notify(run);
    });
  return run;
}

/** Subscribe to the live run for this experiment (if any). */
function useRun(expId: string): Run | null {
  const [, force] = useState(0);
  const run = runs.get(expId) ?? null;
  useEffect(() => {
    const r = runs.get(expId);
    if (!r) return;
    const l = () => force((n) => n + 1);
    r.listeners.add(l);
    return () => {
      r.listeners.delete(l);
    };
    // Re-subscribe whenever a new run object appears for this experiment.
  }, [expId, run]);
  return run;
}

// ---------------------------------------------------------------------------------------------------

interface Props {
  experiment: Experiment;
}

const KIND_OPTIONS = TWIN_KIND_LIST.map((k) => ({ value: k, label: kindLabel(k) }));
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

interface PaintFrame {
  index: number;
  source: ThermalSource;
  /** The whole-frame shift measured against the analysed frame and folded into the source's
   *  registration; null for the analysed frame itself, when the reference is not decoded yet, or when
   *  the frame could not be tracked (then the temperatures are read as if the camera had not moved). */
  shift: ShiftEstimate | null;
}

/**
 * Decode a fetched frame into a paint source (per-frame AGC range, like the 2D player) and align it to
 * the analysed frame: a hand-held camera drifts a few pixels over a clip, so the frame's own offset
 * from the reference (the high-passed `hpRef`) is added to the visible→thermal registration and the
 * vertices read their temperatures through the combined offset. A weak match means the picture no
 * longer resembles the reference (something in front of the lens, the scene rearranged) rather than
 * a drift, and the offset is left at zero — the similarity notice covers that case.
 */
const toPaintFrame = (
  buf: ArrayBuffer,
  index: number,
  record: TwinSceneRecord,
  hpRef: Float32Array | null,
): PaintFrame => {
  const f = getDecodedFrame(buf);
  const reg = record.registration ?? { dx: 0, dy: 0 };
  let shift: ShiftEstimate | null = null;
  if (hpRef && index !== record.recordingIndex) {
    const e = alignFrame(hpRef, highPass(f.temps, f.width, f.height), f.width, f.height);
    if (e.score >= MIN_NCC_SCORE) shift = e;
  }
  const registration = shift ? { dx: reg.dx + shift.dx, dy: reg.dy + shift.dy } : reg;
  // The frame's own range, over its valid pixels and read back from the float32 array: the decoder's
  // min/max are doubles (its hottest pixel would round into the bin below the top), and a truncated
  // frame carries −273.15 sentinels that would drag the range down and recolour everything.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < f.temps.length; i++) {
    const c = f.temps[i];
    if (c > -100) {
      if (c < min) min = c;
      if (c > max) max = c;
    }
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  // The palette position of each temperature follows the same histogram equalisation the FLIR render
  // in the player uses, so a prop's colours match the frame beside it rather than a linear min→max.
  const map = plateauEqualization(f.temps, min, max);
  const source: ThermalSource = { temps: f.temps, width: f.width, height: f.height, min, max, registration, map };
  // The room's temperature, from the pixels no recognised object covers: what a read at the edge of a
  // prop is compared against to tell the object from the wall behind it. Null in a close-up.
  source.ambientC = ambientOutsideBoxes(
    source,
    record.scene.objects.map((o) => o.bbox),
  );
  return { index, shift, source };
};

const TwinPanel = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const unit = useCommonStore((state) => state.temperatureUnit);
  // Read the record off the store so a finished run (which writes there) shows up without a reload.
  const live = useCommonStore((state) => state.experimentMap.get(experiment.id));
  // A photo set's building record shares the field but belongs to the other panel (twinBuildingPanel).
  const rawRecord = live?.twinScene ?? experiment.twinScene ?? null;
  const record: TwinSceneRecord | null = rawRecord && !isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const storedEdits = live?.twinEdits ?? experiment.twinEdits ?? null;
  const isOwner = !!user && user.id === experiment.ownerId;
  const canGenerate = isOwner && isStaff(user) && !!experiment.recordingId;
  const frameCount = Math.max(1, Math.round(experiment.duration * RECORDING_FPS));

  // Whether the recording carries visible-light photos at all. Only app-captured recordings do; a
  // legacy (telelab) recording or a clone of one has nothing for the vision model to recognise, and
  // the server would refuse the frame — better to say so here than after a 30-second motion check.
  // Same probe the player uses for its view toggle (a public metadata read; 404 = legacy). Only the
  // build button and its "cannot be rebuilt" note read it, so a viewer — who only ever sees a twin
  // that already exists — skips the request.
  const [hasVisible, setHasVisible] = useState<boolean | null>(null);
  useEffect(() => {
    setHasVisible(null);
    if (!canGenerate) return;
    if (!experiment.recordingId) {
      setHasVisible(false);
      return;
    }
    let cancelled = false;
    getMetadata(ref(firebaseStorage, `recordings/${experiment.recordingId}/vis_1.jpg`))
      .then(() => !cancelled && setHasVisible(true))
      .catch(() => !cancelled && setHasVisible(false));
    return () => {
      cancelled = true;
    };
  }, [experiment.recordingId, canGenerate]);

  // Bumped when this panel starts a run: the run lives outside React state, so the panel must re-render
  // to pick it up and subscribe (useRun) — otherwise the progress line would never appear.
  const [, runStarted] = useState(0);
  const run = useRun(experiment.id);
  const running = !!run && !run.done;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const runError = run?.done && run.error && run.error !== dismissedError ? run.error : null;

  const [mode, setMode] = useState<TwinViewMode>('thermal');
  const [measuredOnly, setMeasuredOnly] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [follow, setFollow] = useState(true);
  const [resetNonce, setResetNonce] = useState(0);
  const [clearing, setClearing] = useState(false);

  // ---- Corrections. Local state seeded from the doc; the owner's changes are debounced to Firestore
  // and mirrored into the store (so a nav-back sees them); a viewer's stay in this panel.
  const [edits, setEdits] = useState<TwinEdits | null>(storedEdits);
  const editsRef = useRef<TwinEdits | null>(storedEdits);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A new record (regeneration) or a doc reload resets the local corrections to the stored ones.
    setEdits(storedEdits);
    editsRef.current = storedEdits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, experiment.id]);
  const flushSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (isOwner)
        saveTwinEdits(experiment.id, editsRef.current).catch((e) => console.error('failed to save twin edits', e));
    }
  };
  useEffect(() => flushSave, []); // eslint-disable-line react-hooks/exhaustive-deps
  const updateEdits = (next: TwinEdits | null) => {
    setEdits(next);
    editsRef.current = next;
    const store = useCommonStore.getState();
    const cur = store.experimentMap.get(experiment.id);
    if (cur) {
      const { twinEdits: _old, ...rest } = cur;
      store.setExperiment(experiment.id, next ? { ...rest, twinEdits: next } : (rest as Experiment));
    }
    if (!isOwner) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      saveTwinEdits(experiment.id, editsRef.current).catch((e) => console.error('failed to save twin edits', e));
    }, EDIT_SAVE_DEBOUNCE_MS);
  };
  const editObject = (id: string, patch: TwinObjectEdit) => {
    const objects = { ...(edits?.objects ?? {}) };
    const merged: TwinObjectEdit = { ...(objects[id] ?? {}), ...patch };
    // Drop members that say "as the model said" so the stored map stays minimal.
    for (const k of Object.keys(merged) as (keyof TwinObjectEdit)[])
      if (merged[k] === undefined || merged[k] === false) delete merged[k];
    if (Object.keys(merged).length) objects[id] = merged;
    else delete objects[id];
    updateEdits({ ...(edits ?? {}), objects });
  };
  const hasEdits =
    !!edits && ((edits.objects && Object.keys(edits.objects).length > 0) || typeof edits.pitchDeg === 'number');

  // ---- Solve. Camera tilt: the owner's override, else the phone's own sensor reading at record start
  // (capturePose.pitchDeg is elevation ABOVE the horizon, so the downward tilt is its negative), else
  // the model's category.
  const applied = useMemo(() => (record ? applyTwinEdits(record.scene, edits) : null), [record, edits]);
  const sensorPitch =
    experiment.capturePose && Number.isFinite(experiment.capturePose.pitchDeg)
      ? Math.min(85, Math.max(0, -experiment.capturePose.pitchDeg))
      : null;
  const pitchDeg = applied?.pitchDeg ?? sensorPitch ?? (record ? PITCH_DEG[record.scene.camera.pitch] : 15);
  const pitchSource =
    applied?.pitchDeg != null
      ? 'set by you'
      : sensorPitch != null
        ? 'from the phone sensor'
        : 'estimated from the photo';
  const layout = useMemo(() => {
    if (!record || record.blocker || !applied) return null;
    return solveTwinLayout(applied.scene, { pitchDeg, specOverrides: applied.specOverrides });
  }, [record, applied, pitchDeg]);

  // ---- The frame to paint: the player's frame while following, else the analysed one.
  const playerIndex = useCommonStore((state) => state.playerRecordingIndex);
  const playing = useCommonStore((state) => state.playerPlaying);
  const frameIndex = record
    ? follow && playerIndex && playerIndex >= 1 && playerIndex <= frameCount
      ? playerIndex
      : record.recordingIndex
    : null;
  const [thermal, setThermal] = useState<PaintFrame | null>(null);
  const [refTemps, setRefTemps] = useState<Float32Array | null>(null);
  // The analysed frame, high-passed once, is what every painted frame is aligned to.
  const hpRef = useMemo(() => (refTemps ? highPass(refTemps, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT) : null), [refTemps]);
  useEffect(() => {
    setThermal(null);
    setRefTemps(null);
    if (!record || !experiment.recordingId) return;
    let cancelled = false;
    fetchRecordingFrameBufferCached(experiment.recordingId, record.recordingIndex)
      .then((buf) => !cancelled && setRefTemps(getDecodedFrame(buf).temps))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [experiment.recordingId, record]);
  useEffect(() => {
    if (!record || !experiment.recordingId || frameIndex == null) return;
    const recordingId = experiment.recordingId;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        fetchRecordingFrameBufferCached(recordingId, frameIndex)
          .then((buf) => {
            if (cancelled) return;
            setThermal(toPaintFrame(buf, frameIndex, record, hpRef));
          })
          .catch(() => undefined);
        if (follow && playing) {
          for (let k = 1; k <= FOLLOW_PREFETCH; k++) {
            const i = frameIndex + k;
            if (i <= frameCount) fetchRecordingFrameBufferCached(recordingId, i).catch(() => undefined);
          }
        }
      },
      // The analysed frame is wanted immediately; a moving playhead is debounced.
      frameIndex === record.recordingIndex ? 0 : FOLLOW_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // hpRef arrives a moment after the first paint; re-running then aligns the frame already shown.
  }, [experiment.recordingId, record, frameIndex, follow, playing, frameCount, hpRef]);
  const similarity = useMemo(() => {
    if (!thermal || !refTemps || !record || thermal.index === record.recordingIndex) return 1;
    return frameSimilarity(refTemps, thermal.source.temps, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
  }, [thermal, refTemps, record]);

  const generate = () => {
    setDismissedError(null);
    startRun(experiment);
    runStarted((n) => n + 1);
  };

  const clear = async () => {
    setClearing(true);
    try {
      await clearTwinScene(experiment.id);
      const store = useCommonStore.getState();
      const cur = store.experimentMap.get(experiment.id);
      if (cur) {
        const { twinScene: _dropped, twinEdits: _edits, ...rest } = cur;
        store.setExperiment(experiment.id, rest as Experiment);
      }
    } catch (e) {
      const r: Run = {
        progress: '',
        error: e instanceof Error ? e.message : String(e),
        done: true,
        listeners: new Set(),
      };
      runs.set(experiment.id, r);
      setDismissedError(null);
      runStarted((n) => n + 1);
    } finally {
      setClearing(false);
    }
  };

  const placedById = useMemo(() => new Map((layout?.placed ?? []).map((p) => [p.id, p])), [layout]);

  // The owner's build toolbar with its progress / error. With a twin on screen it heads the settings
  // column beside the viewport; before there is one (or when the record could not be rendered) it
  // heads the panel.
  const controls = (
    <>
      {canGenerate && (
        <div className="twin-toolbar">
          <Tooltip
            title={
              hasVisible === false
                ? 'This recording has no visible-light photos, so there is nothing to recognise.'
                : undefined
            }
          >
            <Button
              type={record ? 'default' : 'primary'}
              size="small"
              icon={<ThunderboltOutlined />}
              loading={running}
              onClick={generate}
              disabled={running || hasVisible !== true}
            >
              {record ? 'Regenerate' : 'Build 3D twin'}
            </Button>
          </Tooltip>
          {record && !running && (
            <Popconfirm
              title="Remove the 3D twin?"
              description="Viewers will no longer see it."
              okText="Remove"
              onConfirm={clear}
            >
              <Button size="small" icon={<ClearOutlined />} loading={clearing}>
                Clear
              </Button>
            </Popconfirm>
          )}
        </div>
      )}

      {running && <div className="twin-status twin-status-live">{run!.progress}</div>}
      {runError && (
        <Alert type="error" showIcon closable message={runError} onClose={() => setDismissedError(runError)} />
      )}
    </>
  );
  const showBody = !!(record && layout && applied);

  return (
    <div className="twin-panel">
      {!showBody && controls}

      {!record && !running && hasVisible === false && (
        <Alert
          type="info"
          showIcon
          message="This recording cannot be rebuilt in 3D"
          description="It has no visible-light photos — only recordings captured with the current app carry them (this one is a legacy recording, or a copy of one). The vision model needs the photo to recognise the apparatus; the thermal frames alone are not enough."
        />
      )}
      {!record && !running && hasVisible !== false && (
        <div className="twin-empty">
          {canGenerate
            ? 'Build a 3D model of this setup from one frame: the camera-motion check runs first, then the vision model names and places each object, and the thermal frame is painted onto them.'
            : 'The owner has not built a 3D twin of this experiment yet.'}
        </div>
      )}

      {record?.blocker && (
        <Alert
          type="warning"
          showIcon
          message="Not rendered"
          description={`${record.blocker}${record.scene.reason && record.scene.reason !== record.blocker ? ` (${record.scene.reason})` : ''}`}
        />
      )}

      {record && layout && applied && (
        <div className="twin-body">
          {/* Build toolbar + view toolbar: above the viewport when stacked, top of the right column when
              side by side (App.css .twin-body). */}
          <div className="twin-side-top">
            {controls}
            <section className="twin-section">
              <div className="twin-section-title">
                <span>View</span>
                <Tooltip title="Back to the photographed viewpoint">
                  <Button size="small" type="link" icon={<AimOutlined />} onClick={() => setResetNonce((n) => n + 1)}>
                    Photo view
                  </Button>
                </Tooltip>
              </div>
              <Segmented<TwinViewMode>
                block
                size="small"
                className="twin-view-mode"
                value={mode}
                onChange={(v) => setMode(v)}
                options={[
                  { label: 'Real', value: 'realistic' },
                  { label: 'Thermal', value: 'thermal' },
                  { label: 'Blend', value: 'blended' },
                ]}
              />
              <div className="twin-rows">
                <Tooltip title="Grey out the surfaces the camera never saw (their colours are inferred from the visible side)">
                  <label className="twin-row">
                    <span>Measured only</span>
                    <Switch
                      size="small"
                      checked={measuredOnly}
                      onChange={setMeasuredOnly}
                      disabled={mode === 'realistic'}
                    />
                  </label>
                </Tooltip>
                <label className="twin-row">
                  <span>Labels</span>
                  <Switch size="small" checked={showLabels} onChange={setShowLabels} />
                </label>
                <Tooltip title="Paint the frame the player is on, so heating and cooling play out on the props">
                  <label className="twin-row">
                    <span>Follow playhead</span>
                    <Switch size="small" checked={follow} onChange={setFollow} />
                  </label>
                </Tooltip>
              </div>
              {similarity < SCENE_CHANGED_BELOW && (
                <div className="twin-note">
                  The scene looks different from the analysed frame — something may have moved.
                </div>
              )}
            </section>
          </div>
          <div className="twin-main">
            <div className="twin-canvas">
              <Suspense fallback={<div className="workspace-loading">Loading 3D…</div>}>
                <TwinScene3D
                  layout={layout}
                  thermal={thermal?.source ?? null}
                  palette={experiment.palette ?? null}
                  mode={mode}
                  measuredOnly={measuredOnly}
                  showLabels={showLabels}
                  unit={unit}
                  resetNonce={resetNonce}
                />
              </Suspense>
            </div>
          </div>
          {/* The settings: camera tilt (+ solver warnings) and the object list. Under the toolbars in the
              right column when side by side, under the viewport when stacked; scrolls on its own. */}
          <div className="twin-side-scroll">
            <section className="twin-section">
              <div className="twin-row">
                <span>
                  Camera tilt <span className="twin-muted">· {pitchSource}</span>
                </span>
                <b>{Math.round(pitchDeg)}°</b>
              </div>
              <Slider
                className="twin-slider"
                min={0}
                max={85}
                value={pitchDeg}
                onChange={(v) => updateEdits({ ...(edits ?? {}), pitchDeg: v })}
                tooltip={{ formatter: (v) => `${v}°` }}
              />
              {layout.warnings.map((w) => (
                <div key={w} className="twin-note twin-note-muted">
                  {w}
                </div>
              ))}
            </section>
            <section className="twin-section twin-section-last">
              <div className="twin-section-title">
                <span>
                  Objects{' '}
                  <span className="twin-muted">
                    · {layout.placed.filter((p) => p.rendered).length} drawn
                    {applied.hiddenIds.length ? ` · ${applied.hiddenIds.length} hidden` : ''}
                  </span>
                </span>
                {hasEdits && (
                  <Button size="small" type="link" icon={<UndoOutlined />} onClick={() => updateEdits(null)}>
                    Reset
                  </Button>
                )}
              </div>
              {record.scene.objects.map((o) => {
                const e = edits?.objects?.[o.id] ?? {};
                const kind = e.kind ?? o.kind;
                const placed = placedById.get(o.id);
                const hidden = !!e.hidden;
                const specs = NOMINAL_SIZES[kind] ?? [];
                const others = record.scene.objects.filter((q) => q.id !== o.id && !edits?.objects?.[q.id]?.hidden);
                // A spec that names the thing ("electric kettle", "alcohol lamp") is the title; a bare size
                // ("250 mL"), or the solved dimensions when there is no catalogue, goes in the small print.
                const spec = placed?.spec ?? null;
                const specIsName = !!spec && spec.toLowerCase().includes(kindLabel(kind).toLowerCase());
                const name = capitalize(spec && specIsName ? spec : kindLabel(kind));
                const size = specIsName
                  ? null
                  : (spec ??
                    (placed ? `${Math.round(placed.heightM * 100)} × ${Math.round(placed.widthM * 100)} cm` : null));
                const meta = [
                  size,
                  `${Math.round(o.confidence * 100)}%`,
                  o.thermal.role.replace('_', ' '),
                  hidden ? 'hidden' : NON_RENDERED_KINDS.has(kind) ? 'not drawn' : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <div key={o.id} className={hidden ? 'twin-object twin-object-hidden' : 'twin-object'}>
                    <div className="twin-object-head">
                      <span className="twin-object-name">{name}</span>
                      <span className="twin-muted">{meta}</span>
                    </div>
                    {o.label ? <div className="twin-object-desc">{o.label}</div> : null}
                    <div className="twin-fields">
                      <div className="twin-field">
                        <span>Kind</span>
                        <Select<TwinObjectKind>
                          size="small"
                          value={kind}
                          options={KIND_OPTIONS}
                          onChange={(k) => editObject(o.id, { kind: k === o.kind ? undefined : k, spec: undefined })}
                          popupMatchSelectWidth={false}
                        />
                      </div>
                      <div className="twin-field">
                        <span>Size</span>
                        <Select<string>
                          size="small"
                          value={e.spec ?? 'auto'}
                          disabled={!specs.length}
                          options={[
                            { value: 'auto', label: 'Auto' },
                            ...specs.map((s) => ({ value: s.label, label: s.label })),
                          ]}
                          onChange={(v) => editObject(o.id, { spec: v === 'auto' ? undefined : v })}
                          popupMatchSelectWidth={false}
                        />
                      </div>
                      <div className="twin-field">
                        <span>Placed</span>
                        <Select<string>
                          size="small"
                          value={e.restingOn ?? o.restingOn}
                          options={[
                            { value: 'support', label: `On the ${record.scene.support.kind}` },
                            ...others.map((q) => ({
                              value: q.id,
                              label: `On the ${kindLabel(edits?.objects?.[q.id]?.kind ?? q.kind)}`,
                            })),
                            { value: 'held', label: 'Held in the air' },
                          ]}
                          onChange={(v) => editObject(o.id, { restingOn: v === o.restingOn ? undefined : v })}
                          popupMatchSelectWidth={false}
                        />
                      </div>
                      <label className="twin-field">
                        <span>Shown</span>
                        <Switch
                          size="small"
                          checked={!hidden}
                          onChange={(shown) => editObject(o.id, { hidden: !shown })}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        </div>
      )}
    </div>
  );
};

export default TwinPanel;
