/**
 * The "Digital Twin" workspace tab for a RECORDING (docs/digital-twin-plan.md §9–§11, §18). A recording is
 * rebuilt one of two ways, and the build finds out which from how the camera moved (§39): the camera-motion
 * gate runs over the clip's thermal frames and, when they hold still, the photos of a few frames are
 * compared too (utils/twinCameraMotion) — the owner is not asked.
 *
 *   Fixed camera — the phone stood still: the stillest frame
 *     goes to the scene-analysis Function, and the objects it names are placed as props (twinScene3d).
 *     The layout is frozen at the analysed frame, but the paint follows whatever frame the player shows,
 *     so heating and cooling play out on the props; a similarity check against the analysed frame warns
 *     when the scene no longer looks like the one the twin was built from. The owner's corrections
 *     (twinEdits) are applied on top of the model's answer.
 *   Walk-around — the phone moved round the subject: frames sampled from the clip go to the
 *     scene-program Function (the photo set's path, source 'orbit'), which writes the subject as a small
 *     three.js program and traces the surfaces the camera measured; TwinBuildingViewer shows it.
 *
 * Both records live in the experiment's twinScene field, told apart by `kind`. Owner + staff generate;
 * everyone else sees what the owner built. A generation outlives this panel (twinRun.ts): switching tabs
 * must not cancel a run of a minute or more, so the work writes its result into the store when it
 * finishes and the panel just subscribes to the progress while it is mounted. The owner can stop a
 * generation part-way, which leaves the twin as it was.
 *
 * Before there is a twin the owner's view is the build form (twinBuildCompose, §20) — what they want from
 * the model, and which AI model builds it; once there is one, Regenerate opens the same form, started from
 * the twin on screen.
 *
 * A fixed-camera twin's About — folded at the very top of its right column until opened — says which AI
 * model made it, and holds the revision thread (twinRevise, §24), as a scene twin's About does: the owner
 * tells the AI what is wrong with the 3D scene, and the model revises its analysis of the same frame with the
 * note, the analysis as the owner sees it (their corrections applied) and the request before it. While it
 * runs the corrections are held still — the revision answers for the ones it was sent; it lands with the
 * tilt and the sizes that outlive it, and what it could not use leaves the twin as it was.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Popconfirm, Segmented, Select, Slider, Switch, Tooltip } from 'antd';
import {
  AimOutlined,
  ClearOutlined,
  LoadingOutlined,
  RightOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { getBlob, getMetadata, ref } from 'firebase/storage';
import {
  Experiment,
  TwinBuildingRecord,
  TwinEdits,
  TwinObjectEdit,
  TwinObjectKind,
  TwinSceneRecord,
  isTwinBuildingRecord,
} from '../../../types';
import useCommonStore from '../../../stores/common';
import { firebaseStorage } from '../../../services/firebase';
import { isStaff } from '../../../utils/staff';
import { analyzeTwinBuilding, analyzeTwinScene, clearTwinScene, reviseTwinScene } from '../../../services/ai';
import { saveTwinEdits } from '../../../services/experiments';
import { fetchRecordingFrameBufferCached } from '../../../utils/recordingFrame';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import { formatFilmTime, lastFrameIndexOf } from '../../../utils/frameTime';
import { useMappingIndex } from '../hooks';
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
  type VisibleMotion,
  assessVisibleMotion,
  cameraMotionKind,
  neighbourIndex,
  visibleCheckIndices,
} from '../../../utils/twinCameraMotion';
import { grayFromRgba } from '../../../../functions/src/twinRegistration';
import { visibleLuma } from '../../../../functions/src/twinOrbit';
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
import TwinBuildingViewer, { TwinDeleteButton } from './twinBuildingViewer';
import TwinBuildCompose, { type TwinBuildRequest, TwinRequestNote } from './twinBuildCompose';
import {
  TWIN_MODEL_LABELS,
  type TwinBuildKind,
  type TwinBuildSource,
  type TwinModelKey,
  clearTwinBuildDraft,
  clearTwinNoteDraft,
  isTwinModelKey,
  readTwinBuildDraft,
  savedTwinModel,
  twinBuildDraftStamp,
  twinModelLabel,
  twinModelOf,
  updateTwinBuildDraft,
} from './twinModels';
import TwinFramePicker from './twinFramePicker';
import TwinRevise from './twinRevise';
import TwinLiveProgress from './twinLiveProgress';
import {
  SAVED_AFTER_STOP,
  type TwinFeed,
  type TwinRun,
  failTwinRun,
  startTwinRun,
  stopTwinRun,
  storeTwinRecord,
  twinBuildStopTitle,
  twinRunStoppable,
  useTwinBuildRun,
  useTwinRun,
} from './twinRun';

// three.js lives in this lazily-loaded chunk — it only downloads on first open of the tab.
const TwinScene3D = lazy(() => import('./twinScene3d'));

/** Parallel Storage reads while sampling frames for the motion gate. */
const FETCH_POOL = 4;
/** A frame's visible photo is drawn this wide before the motion check takes its luma — the width the
 *  server measures it at (TWIN_ORBIT_SHARPNESS_WIDTH in functions/src/index.ts). */
const VISIBLE_CHECK_WIDTH = 240;
/** How long the playhead must rest on a frame before the twin fetches it (scrubbing skips frames). */
const FOLLOW_DEBOUNCE_MS = 120;
/** Frames warmed ahead of the playhead while playing, so playback does not stall on fetches. */
const FOLLOW_PREFETCH = 3;
/** Below this similarity to the analysed frame the scene is probably rearranged (plan §11). */
const SCENE_CHANGED_BELOW = 0.45;
/** Owner corrections are saved this long after the last change. */
const EDIT_SAVE_DEBOUNCE_MS = 800;
/** The experiments whose About was left open, for the page session: switching tabs remounts the panel, and
 *  must not fold a conversation with the AI the owner is in the middle of. */
const aboutOpenByExp = new Map<string, boolean>();

// ---------------------------------------------------------------------------------------------------
// The generation: the body of a twinRun.ts run. It reports through `set` and `remark`, throws to fail,
// stops when `signal` fires (the owner's Stop), and writes the record into the store itself so a panel
// that was unmounted meanwhile still finds it.

/**
 * What a recording's twin is built from, the owner's choice on the build form (§40): the whole video — the
 * build checks how the camera moved and takes the frames it needs (§39), the default — or the frames the
 * owner picks in the player, which go to the model as a photo set's photos do. `lead` says what a build
 * does on the card before there is a twin (the automatic one covers both kinds of twin, since the build
 * picks); `hint` is its one line under the choice when the form opens from Regenerate.
 */
const BUILD_SOURCES: { value: TwinBuildSource; label: string; hint: string; lead: string }[] = [
  {
    value: 'video',
    label: 'Automatic',
    hint: 'From the whole video: the build checks how the camera moved and takes the frames it needs.',
    lead: 'From the whole video. The camera-motion check runs first. A camera that stood still: an AI model names and places each object in one frame, and the thermal frame is painted onto them. A camera that walked around the subject: the model writes a 3D scene you can orbit from several frames, painted with the temperatures the camera measured.',
  },
  {
    value: 'frames',
    label: 'Pick frames',
    hint: 'From the frames you pick: move the player to a frame that shows the subject well and add it.',
    lead: 'From the frames you pick: move the player to a frame that shows the subject well and add it — one per side of the subject, if the camera moved. An AI model reads the subject off those frames and writes it as a 3D scene you can orbit, painted with the temperatures the camera measured.',
  },
];

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

/** From the frames the owner picked (§40): they go to analyzeTwinBuilding as they are — the server neither
 *  samples the clip nor checks how its camera moved — with the owner's choice of model and their request.
 *  `timeOf` names a frame the way the picker does, by its time on the player's clock: the server's refusal
 *  of frames without a visible photo speaks in frame numbers, which the owner never sees. */
async function generateFromFrames(
  experiment: Experiment,
  request: TwinBuildRequest,
  frames: number[],
  timeOf: (frame: number) => string,
  set: (progress: string) => void,
  signal: AbortSignal,
  feed: TwinFeed,
  remark: (note: string) => void,
): Promise<void> {
  remark(`Building from the ${frames.length === 1 ? 'frame' : `${frames.length} frames`} you picked.`);
  // No line of its own: the Function streams where it is and what the model writes (§28.5).
  set('');
  try {
    storeTwinRecord(
      experiment.id,
      await analyzeTwinBuilding(experiment.id, 'orbit', { ...request, frames }, signal, feed),
    );
  } catch (e) {
    const details = (e as { details?: { reason?: unknown; frames?: unknown } } | null)?.details;
    const missing =
      !signal.aborted && details?.reason === 'frames-without-photo' && Array.isArray(details.frames)
        ? details.frames.filter((k): k is number => typeof k === 'number')
        : [];
    if (!missing.length) throw e;
    throw new Error(
      missing.length === 1
        ? `The frame at ${timeOf(missing[0])} has no visible-light photo to build from — pick another frame.`
        : `The frames at ${missing.map(timeOf).join(', ')} have no visible-light photo to build from — pick other frames.`,
    );
  }
}

/** The visible photo of a recording frame as the motion check compares it (twinOrbit.visibleLuma); null
 *  when the frame has none (it never uploaded) or it cannot be decoded — the check does without it. */
async function fetchVisibleLuma(recordingId: string, index: number): Promise<Float32Array | null> {
  try {
    const blob = await getBlob(ref(firebaseStorage, `recordings/${recordingId}/vis_${index}.jpg`));
    const bitmap = await createImageBitmap(blob);
    try {
      const width = Math.min(bitmap.width, VISIBLE_CHECK_WIDTH);
      const height = Math.max(3, Math.round((bitmap.height * width) / bitmap.width));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      return visibleLuma(grayFromRgba(ctx.getImageData(0, 0, width, height).data, width, height));
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/** The server's refusal to build a walk-around twin of a clip whose camera never left its standpoint
 *  (loadOrbitFrames in functions/src/index.ts). */
const isCameraStillRefusal = (e: unknown): boolean =>
  (e as { details?: { reason?: unknown } } | null)?.details?.reason === 'camera-still';

/**
 * Build a recording's twin, of the kind its camera calls for (§39): the motion gate over the clip's thermal
 * frames, then — when they hold still — the photos of a few frames against the stillest one's
 * (utils/twinCameraMotion). A camera that stood still: the stillest frame to analyzeTwinScene. One that
 * moved: analyzeTwinBuilding, which samples the frames itself. Either way with the owner's choice of
 * model and their request, and the record goes to the store.
 */
async function generateRecordingTwin(
  experiment: Experiment,
  request: TwinBuildRequest,
  set: (progress: string) => void,
  signal: AbortSignal,
  feed: TwinFeed,
  remark: (note: string) => void,
): Promise<void> {
  const recordingId = experiment.recordingId!;
  const frameCount = lastFrameIndexOf(experiment) + 1;
  const indices = stabilitySampleIndices(frameCount);
  let fetched = 0;
  set(`Checking camera motion… 0/${indices.length} frames`);
  const samples = await mapPool(indices, FETCH_POOL, async (index) => {
    // Stopped: the frames not yet fetched are skipped rather than read for nothing.
    if (signal.aborted) return null;
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
  signal.throwIfAborted();
  const valid = samples.filter((s): s is { index: number; temps: Float32Array } => !!s);
  if (!valid.length) throw new Error('No thermal frames could be read from this recording.');
  const stability = assessStability(valid, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
  // The thermal frames hold still: the photos get a say, as a walk around a subject that looks the same
  // from every side in the thermal frame passes the gate.
  let visible: VisibleMotion | null = null;
  if (stability.stable) {
    set('Checking camera motion… comparing the photos');
    const neighbour = neighbourIndex(stability.referenceIndex, frameCount);
    const [reference, next] = await Promise.all([
      fetchVisibleLuma(recordingId, stability.referenceIndex),
      neighbour === null ? null : fetchVisibleLuma(recordingId, neighbour),
    ]);
    if (reference && next) {
      const others = visibleCheckIndices(
        valid.map((s) => s.index),
        stability.referenceIndex,
      );
      const lumas = await mapPool(others, FETCH_POOL, (index) =>
        signal.aborted ? Promise.resolve(null) : fetchVisibleLuma(recordingId, index),
      );
      visible = assessVisibleMotion(reference, next, lumas);
    }
    signal.throwIfAborted();
  }
  // The form offers one list of models for both kinds; should the two lists ever differ, a model the
  // kind does not take gives way to the one last chosen for it.
  const options = (kind: TwinBuildKind): TwinBuildRequest => ({
    ...request,
    model: isTwinModelKey(request.model, kind) ? request.model : savedTwinModel(kind),
  });
  const buildFixed = async () => {
    const asked = options('fixed');
    remark(
      `The camera stood still (drift ≤ ${stability.maxShiftPx} px, corrected frame by frame): building a fixed-camera twin.`,
    );
    set(`Analysing frame ${stability.referenceIndex} with ${TWIN_MODEL_LABELS[asked.model]}…`);
    storeTwinRecord(
      experiment.id,
      await analyzeTwinScene(experiment.id, stability.referenceIndex, stability, asked, signal, feed),
    );
  };
  if (cameraMotionKind(stability, visible) === 'fixed') return buildFixed();

  remark(
    stability.stable && visible
      ? `The camera moved around the subject (${visible.moved} of the ${visible.compared} photos compared show it from another standpoint): building a walk-around twin.`
      : `The camera moved (the picture drifts ${stability.maxShiftPx} px from the stillest frame): building a walk-around twin.`,
  );
  // No line of its own: the Function streams where it is and what the model writes (§28.5).
  set('');
  try {
    storeTwinRecord(experiment.id, await analyzeTwinBuilding(experiment.id, 'orbit', options('program'), signal, feed));
  } catch (e) {
    if (signal.aborted || !isCameraStillRefusal(e)) throw e;
    // The server's own gate — fewer frames, the clip's first and last moments left out — found no walk.
    // A clip the thermal gate passed is a fixed camera after all; one it failed fits neither kind.
    if (stability.stable) return buildFixed();
    throw new Error(
      `The camera moved too much for a fixed-camera twin — the picture drifts ${stability.maxShiftPx} px from the stillest frame, and the twin can only correct up to ${STABLE_MAX_SHIFT_PX} px (about 4° of pan) — yet it never left its standpoint, so there is nothing to walk around either. Keep the phone still (a stand helps), or walk around the subject, and record again.`,
    );
  }
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
  // One field, two kinds of record: the fixed-camera props scene this panel draws itself, or the
  // walk-around scene program TwinBuildingViewer shows. `record` stays the props scene below, as every
  // fixed-camera hook reads it; they all sit idle while a walk-around record is stored.
  const rawRecord = live?.twinScene ?? experiment.twinScene ?? null;
  const record: TwinSceneRecord | null = rawRecord && !isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const orbitRecord: TwinBuildingRecord | null = rawRecord && isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const storedEdits = live?.twinEdits ?? experiment.twinEdits ?? null;
  const isOwner = !!user && user.id === experiment.ownerId;
  const canGenerate = isOwner && isStaff(user) && !!experiment.recordingId;
  const frameCount = lastFrameIndexOf(experiment) + 1;

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

  const {
    running,
    building,
    revising,
    error: runError,
    stopped,
    savedAfterStop,
    dismiss,
  } = useTwinBuildRun(experiment.id);

  // ---- About (§24): folded until the owner opens it. Folded, its title row says what it hides that they
  // would want to know — a revision running, or one that failed, until About has been opened since (a Stop is
  // pressed in the open thread, so a stopped revision has been seen). Open, the end of the conversation (the
  // newest round, the box) is what shows when it runs past the height About is allowed.
  const [aboutOpen, setAboutOpenState] = useState(() => aboutOpenByExp.get(experiment.id) ?? false);
  const setAboutOpen = (open: boolean) => {
    aboutOpenByExp.set(experiment.id, open);
    setAboutOpenState(open);
  };
  const aboutBodyRef = useRef<HTMLDivElement>(null);
  const lastRun = useTwinRun(experiment.id);
  const failedRevision =
    lastRun && lastRun.done && lastRun.revision && lastRun.error && !lastRun.dismissed ? lastRun : null;
  const [seenFailure, setSeenFailure] = useState<TwinRun | null>(null);
  useEffect(() => {
    if (aboutOpen && failedRevision) setSeenFailure(failedRevision);
  }, [aboutOpen, failedRevision]);
  const unseenFailure = !aboutOpen && failedRevision !== seenFailure ? failedRevision : null;
  const revisionCount = record?.revisions?.length ?? 0;
  const lastRunDone = !!lastRun?.done;
  useEffect(() => {
    const body = aboutBodyRef.current;
    if (aboutOpen && body) body.scrollTop = body.scrollHeight;
  }, [aboutOpen, revisionCount, lastRun, lastRunDone]);

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
  // The save on its way to Firestore, if any — which a revision waits for (below).
  const saving = useRef<Promise<void> | null>(null);
  useEffect(() => {
    // A new record (regeneration) or a doc reload resets the local corrections to the stored ones.
    setEdits(storedEdits);
    editsRef.current = storedEdits;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, experiment.id]);
  const save = (next: TwinEdits | null): Promise<void> => {
    const pending = saveTwinEdits(experiment.id, next);
    saving.current = pending;
    const settle = () => {
      if (saving.current === pending) saving.current = null;
    };
    pending.then(settle, settle);
    return pending;
  };
  const flushSave = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (isOwner) save(editsRef.current).catch((e) => console.error('failed to save twin edits', e));
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
      save(editsRef.current).catch((e) => console.error('failed to save twin edits', e));
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

  // ---- Revising (§24). The server reads the corrections off the doc and shows them to the model folded into
  // the analysis, so a change still waiting to be saved — or still being saved — is saved before the note
  // goes; and while the revision runs, the corrections are held still (the controls below are disabled): it
  // answers for the corrections it was sent, and would land over any made meanwhile.
  const saveEditsNow = async () => {
    if (!isOwner) return;
    try {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        await save(editsRef.current);
      } else if (saving.current) {
        await saving.current;
      }
    } catch (e) {
      throw new Error(
        `Your latest corrections could not be saved, so the note was not sent: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const reviseAnalysis = async (
    note: string,
    model: TwinModelKey,
    set: (progress: string) => void,
    signal: AbortSignal,
    // A fixed-camera note carries no selection or pictures (§28): the thread offers neither.
    _extras: unknown,
    feed?: TwinFeed,
  ) => {
    // The thread is where the answer arrives: About is open on it when the twin comes back — also when the
    // note was sent from under the not-rendered notice, which the drawn twin then replaces.
    setAboutOpen(true);
    await saveEditsNow();
    signal.throwIfAborted();
    // No progress sentence (§28.4): the thread's pending turn spins until the answer lands.
    set('');
    const revised = await reviseTwinScene(experiment.id, { note, model }, signal, feed);
    storeTwinRecord(experiment.id, revised.twinScene, revised.twinEdits);
  };

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

  // Regenerate opens the build form in place of the toolbar; building (or Cancel) closes it.
  const [composing, setComposing] = useState(false);
  // Before there is a twin, how a build ended appears under the card, which a short workspace scrolls
  // (.twin-start): bring it into view when a build stops or fails. (A running build is the card itself, §28.6.)
  const startRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const start = startRef.current;
    if (start && (runError || stopped)) start.scrollTop = start.scrollHeight;
  }, [runError, stopped]);
  // What the twin is built from (§40): the whole video unless the owner chose to pick the frames. Both the
  // choice and the frames picked so far are part of the build form's draft (twinModels.ts), so they survive
  // the panel unmounting — a tab switch must not empty the strip — and start over with the draft: when a
  // build has stored a twin, or the owner cancels.
  const [buildSource, setBuildSourceState] = useState<TwinBuildSource>(
    () => readTwinBuildDraft(experiment.id).source ?? 'video',
  );
  const [pickedFrames, setPickedFramesState] = useState<number[]>(() => readTwinBuildDraft(experiment.id).frames ?? []);
  useEffect(() => {
    const draft = readTwinBuildDraft(experiment.id);
    setBuildSourceState(draft.source ?? 'video');
    setPickedFramesState(draft.frames ?? []);
  }, [experiment.id, rawRecord]);
  const setBuildSource = (next: TwinBuildSource) => {
    setBuildSourceState(next);
    updateTwinBuildDraft(experiment.id, { source: next });
  };
  const setPickedFrames = (next: number[]) => {
    setPickedFramesState(next);
    updateTwinBuildDraft(experiment.id, { frames: next });
  };
  const fromFrames = buildSource === 'frames';
  // A picked frame is named by its time on the player's clock (twinFramePicker), in a build's errors too.
  const { getPlayerIndex } = useMappingIndex(experiment.segments, experiment);

  const generate = (request: TwinBuildRequest) => {
    if (fromFrames && !pickedFrames.length) return;
    setComposing(false);
    const draft = twinBuildDraftStamp(experiment.id);
    const frames = fromFrames ? pickedFrames : null;
    const timeOf = (frame: number) => formatFilmTime(getPlayerIndex(frame));
    startTwinRun(experiment.id, async (set, signal, feed, remark) => {
      await (frames
        ? generateFromFrames(experiment, request, frames, timeOf, set, signal, feed, remark)
        : generateRecordingTwin(experiment, request, set, signal, feed, remark));
      // The twin now carries the request it was built to; the next regeneration starts from that.
      clearTwinBuildDraft(experiment.id, draft);
    });
  };
  const cancelCompose = () => {
    setComposing(false);
    clearTwinBuildDraft(experiment.id);
    setBuildSourceState('video');
    setPickedFramesState([]);
  };

  const clear = async () => {
    setClearing(true);
    try {
      await clearTwinScene(experiment.id);
      // A note half-written about the removed twin is not about the next one (§31.7).
      clearTwinNoteDraft(experiment.id);
      const store = useCommonStore.getState();
      const cur = store.experimentMap.get(experiment.id);
      if (cur) {
        const { twinScene: _dropped, twinEdits: _edits, ...rest } = cur;
        store.setExperiment(experiment.id, rest as Experiment);
      }
    } catch (e) {
      failTwinRun(experiment.id, e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  const placedById = useMemo(() => new Map((layout?.placed ?? []).map((p) => [p.id, p])), [layout]);

  // The owner's build form and toolbar (§20), with the build's progress / outcome. Before there is a twin
  // the form is the panel's content (a card); once there is one, the toolbar — Regenerate… / Stop / Clear —
  // opens the same form in its place. With a fixed-camera twin on screen the toolbar sits at the top of the
  // settings column beside the viewport, under the folded About, and heads the panel when a fixed-camera
  // record could not be laid out. A
  // walk-around twin's viewer places it itself: at the foot of the settings column (closing About, on the
  // Realistic view), or under the notice when its record cannot be shown.
  // What a build throws away besides the twin itself, said beside the button: the revision thread and the
  // owner's corrections. Only a fixed-camera twin is rebuilt from the form — a walk-around twin is
  // deleted first (its viewer's Delete), and the form then starts from nothing.
  const storedRevisions = record?.revisions?.length ?? 0;
  const lost = [
    storedRevisions ? `the ${storedRevisions === 1 ? 'revision' : `${storedRevisions} revisions`} made to it` : null,
    record && hasEdits ? 'your corrections to it' : null,
  ].filter((s): s is string => !!s);
  const replaces =
    rawRecord && lost.length
      ? `This replaces the twin${lost.length === 2 ? `, ${lost[0]} and ${lost[1]}` : ` and ${lost[0]}`}.`
      : null;
  const noPhotos = 'This recording has no visible-light photos, so there is nothing to recognise.';
  const stop = () => stopTwinRun(experiment.id);
  const how = BUILD_SOURCES.find((s) => s.value === buildSource)!;
  const noFrames = fromFrames && !pickedFrames.length;
  // The choice of what to build from, and under it the frames picked. The card says what the choice does
  // in its lead, below; the form Regenerate opens has no lead, so the line goes here.
  const sourceChoice = (withHint: boolean) => (
    <div className="twin-gen-mode">
      <Segmented<TwinBuildSource>
        size="small"
        className="twin-view-mode"
        // The two choices share the track (its width is capped like the view switch's), rather than
        // sitting at its left beside an empty stretch.
        block
        value={buildSource}
        disabled={running || clearing}
        onChange={setBuildSource}
        options={BUILD_SOURCES.map((s) => ({ value: s.value, label: s.label }))}
      />
      {withHint && <div className="twin-note-muted">{how.hint}</div>}
    </div>
  );
  const framePicker = fromFrames && experiment.recordingId && (
    <TwinFramePicker
      experiment={experiment}
      recordingId={experiment.recordingId}
      frameCount={frameCount}
      frames={pickedFrames}
      disabled={running || clearing}
      onChange={setPickedFrames}
    />
  );
  const compose = (layout: 'card' | 'inline') => (
    <TwinBuildCompose
      expId={experiment.id}
      // Picked frames always make a scene program. From the whole video, which kind of twin the recording
      // gets is only known once the build has checked its camera (§39), and one list of models serves both:
      // the form keeps the fixed-camera kind's choice, the common case. Either way it preselects the model
      // of the twin on screen, when that model is offered.
      kind={fromFrames ? 'program' : 'fixed'}
      from={record}
      request={record?.instructions}
      layout={layout}
      title={layout === 'card' ? 'Build a digital twin' : undefined}
      header={sourceChoice(layout === 'inline')}
      lead={layout === 'card' ? how.lead : undefined}
      picker={framePicker || undefined}
      submitLabel={rawRecord ? 'Regenerate' : 'Build digital twin'}
      warning={replaces}
      building={!!building}
      progress={building ? <TwinLiveProgress run={building} icon={<LoadingOutlined spin />} /> : undefined}
      // Not while a clear is in flight either: a run started then would be racing the removal.
      disabled={running || clearing || hasVisible !== true || noFrames}
      disabledReason={
        hasVisible === false
          ? noPhotos
          : hasVisible === null
            ? 'Checking the recording for visible-light photos…'
            : noFrames
              ? 'Add at least one frame to build from.'
              : null
      }
      onBuild={generate}
      onStop={stop}
      stopDisabled={!!building && !twinRunStoppable(building)}
      stopTitle={building?.stopping ? 'Stopping…' : undefined}
      onCancel={rawRecord ? cancelCompose : undefined}
    />
  );
  const status = (
    <>
      {/* A fixed-camera build's steps (frames checked), then what the Function streams of either build (§28.5) —
          under the toolbar of a twin on screen; before there is one, the card is the progress (§28.6). */}
      {building && rawRecord && <TwinLiveProgress run={building} icon={<LoadingOutlined spin />} />}
      {stopped && (
        <Alert
          type="info"
          showIcon
          closable
          message={rawRecord ? 'Stopped — the twin was left as it was.' : 'Stopped — nothing was built.'}
          onClose={dismiss}
        />
      )}
      {savedAfterStop && <Alert type="info" showIcon closable message={SAVED_AFTER_STOP} onClose={dismiss} />}
      {runError && <Alert type="error" showIcon closable message={runError} onClose={dismiss} />}
    </>
  );
  const regenerateButton = (
    <Button
      size="small"
      icon={<ThunderboltOutlined />}
      loading={!!building}
      onClick={() => setComposing(true)}
      disabled={running || clearing || hasVisible !== true}
      title={
        hasVisible === true ? 'Build a fresh twin — with a new request or another AI model if you like' : undefined
      }
    >
      Regenerate…
    </Button>
  );
  const controls = (
    <>
      {canGenerate &&
        (composing && !building ? (
          compose('inline')
        ) : (
          <div className="twin-toolbar">
            {hasVisible === false ? <Tooltip title={noPhotos}>{regenerateButton}</Tooltip> : regenerateButton}
            {building && (
              <Button
                size="small"
                danger
                onClick={stop}
                disabled={!twinRunStoppable(building)}
                title={twinBuildStopTitle(building)}
              >
                Stop
              </Button>
            )}
            {!running && (
              <Popconfirm
                title="Remove the digital twin?"
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
        ))}
      {status}
    </>
  );
  // A walk-around twin has no Regenerate / Clear: its viewer puts Delete on About's title row, and under
  // About only a build's Stop and how it went.
  const orbitControls = (
    <>
      {canGenerate && building && (
        <div className="twin-toolbar">
          <Button
            size="small"
            danger
            onClick={stop}
            disabled={!twinRunStoppable(building)}
            title={twinBuildStopTitle(building)}
          >
            Stop
          </Button>
        </div>
      )}
      {status}
    </>
  );
  const orbitDelete = canGenerate && !running ? <TwinDeleteButton onConfirm={clear} loading={clearing} /> : null;
  // A walk-around record hands the toolbar to its viewer, which closes the settings column with it (or
  // puts it under the notice that there is no scene); a fixed-camera record places it below, at the top of
  // its settings column under the folded About, once it has a layout.
  const showBody = !!(record && layout && applied);

  // A fixed-camera twin's revision thread (§24): in its About — or, unfolded, under the notice when it was not
  // rendered, since a note is how the owner tells the model what it failed to recognise.
  const reviseThread = record && (
    <TwinRevise
      experiment={experiment}
      revisions={record.revisions ?? []}
      kind="fixed"
      madeBy={twinModelOf(record, 'fixed')}
      canRevise={canGenerate}
      reviseTitle={(model) =>
        `${model} revises what it recognised in frame ${record.recordingIndex} from your note; the twin is laid out again`
      }
      revise={reviseAnalysis}
    />
  );
  // Which AI model made the analysis as it stands: after a revision, the model the last note went to (which
  // the owner may have picked); the thread says which model took each note.
  const provenance = !record
    ? null
    : revisionCount > 0
      ? `Named and placed from frame ${record.recordingIndex} and revised ${revisionCount === 1 ? 'once' : revisionCount === 2 ? 'twice' : `${revisionCount} times`} from the owner's notes, most recently by ${twinModelLabel(record)}.`
      : `Named and placed by ${twinModelLabel(record)} from frame ${record.recordingIndex}.`;

  return (
    <div className="twin-panel">
      {/* A fixed-camera record with nothing to lay out (declined, or unsolvable): the toolbar — or the build
          form Regenerate opens — then the notice and the revision thread, scrolling inside the panel. */}
      {rawRecord && !showBody && !orbitRecord && (
        <div className="twin-notice-stack">
          {controls}
          {record?.blocker && (
            <Alert
              type="warning"
              showIcon
              message="Not rendered"
              description={`${record.blocker}${record.scene.reason && record.scene.reason !== record.blocker ? ` (${record.scene.reason})` : ''}`}
            />
          )}
          {reviseThread}
        </div>
      )}

      {!rawRecord && canGenerate && hasVisible === false && (
        <Alert
          type="info"
          showIcon
          message="This recording cannot be rebuilt in 3D"
          description="It has no visible-light photos — only recordings captured with the current app carry them (this one is a legacy recording, or a copy of one). The AI model needs the photo to recognise the apparatus; the thermal frames alone are not enough."
        />
      )}
      {!rawRecord && canGenerate && hasVisible !== false && (
        <div className="twin-start" ref={startRef}>
          {compose('card')}
          {status}
        </div>
      )}
      {!rawRecord && !canGenerate && (
        <div className="twin-empty">
          {isOwner && !isStaff(user)
            ? 'Building digital twins is open to staff accounts only for now.'
            : 'The owner has not built a digital twin of this experiment yet.'}
        </div>
      )}

      {orbitRecord && (
        <TwinBuildingViewer
          record={orbitRecord}
          experiment={experiment}
          controls={orbitControls}
          deleteAction={orbitDelete}
          source="orbit"
        />
      )}

      {record && layout && applied && (
        <div className="twin-body">
          {/* About (folded), the build toolbar and the view toolbar: above the viewport when stacked, top of the
              right column when side by side (App.css .twin-body). */}
          <div className="twin-side-top">
            <section className="twin-section twin-about-section">
              <details className="twin-about" open={aboutOpen} onToggle={(e) => setAboutOpen(e.currentTarget.open)}>
                <summary className="twin-section-title">
                  <span className="twin-about-head">
                    <RightOutlined className="twin-about-caret" />
                    <span>About</span>
                    <span className="twin-muted">
                      · {twinModelLabel(record)}
                      {revisionCount ? ` · ${revisionCount} ${revisionCount === 1 ? 'revision' : 'revisions'}` : ''}
                    </span>
                  </span>
                  {!aboutOpen && revising ? (
                    <span className="twin-about-status">
                      <LoadingOutlined spin />
                      Revising…
                    </span>
                  ) : unseenFailure ? (
                    <span className="twin-about-status twin-about-status-failed">Note not applied</span>
                  ) : null}
                </summary>
                <div className="twin-about-body" ref={aboutBodyRef}>
                  <div className="twin-note-muted">{provenance}</div>
                  <TwinRequestNote instructions={record.instructions} ownerViewing={isOwner} />
                  {reviseThread}
                </div>
              </details>
            </section>
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
          {/* The settings: camera tilt (+ solver warnings) and the object list. Under the toolbars in the right
              column when side by side, under the viewport when stacked; scrolls on its own. */}
          <div className="twin-side-scroll">
            <section className="twin-section">
              {revising && (
                <div className="twin-note-muted">Your corrections are paused while the AI revises the twin.</div>
              )}
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
                disabled={revising}
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
                  <Button
                    size="small"
                    type="link"
                    icon={<UndoOutlined />}
                    disabled={revising}
                    onClick={() => updateEdits(null)}
                  >
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
                          disabled={revising}
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
                          disabled={revising || !specs.length}
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
                          disabled={revising}
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
                          disabled={revising}
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
