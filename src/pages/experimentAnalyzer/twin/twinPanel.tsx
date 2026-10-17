/**
 * The "Digital Twin" workspace tab for a RECORDING (docs/digital-twin-plan.md §9, §18, §39–§42). Every
 * twin is a scene program an AI model writes (the photo set's path, analyzeTwinBuilding) and
 * TwinBuildingViewer runs: the model draws what it sees, with no list of kinds to choose from and no
 * solver placing props for it (§42). What differs is which frames the model is shown, and the build finds
 * that out from how the camera moved (§39) — the owner is not asked:
 *
 *   Fixed camera — the phone stood still: the camera-motion gate runs over the clip's thermal frames and,
 *     when they hold still, the photos of a few frames are compared too (utils/twinCameraMotion); the
 *     stillest frame goes to the model, alone, as a picked frame would (§40).
 *   Walk-around — the phone moved round the subject: the Function samples the clip's frames itself
 *     (source 'orbit') and the model writes the subject from several sides.
 *
 * Or the owner picks the frames in the player (§40). Owner + staff generate; everyone else sees what the
 * owner built. A generation outlives this panel (twinRun.ts): switching tabs must not cancel a run of a
 * minute or more, so the work writes its result into the store when it finishes and the panel just
 * subscribes to the progress while it is mounted. The owner can stop a generation part-way, which leaves
 * the twin as it was.
 *
 * Before there is a twin the owner's view is the build form (twinBuildCompose, §20) — what they want from
 * the model, and which AI model builds it. A twin from before §42 — an object list a solver laid out as
 * props — is no longer drawn: the panel says so and offers the form, so the owner can have the model draw it.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Popconfirm, Segmented, Tooltip } from 'antd';
import { ClearOutlined, LoadingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { getBlob, getMetadata, ref } from 'firebase/storage';
import { Experiment, TwinBuildingRecord, TwinLegacySceneRecord, isTwinBuildingRecord } from '../../../types';
import useCommonStore from '../../../stores/common';
import { firebaseStorage } from '../../../services/firebase';
import { isStaff } from '../../../utils/staff';
import { analyzeTwinBuilding, clearTwinScene } from '../../../services/ai';
import { fetchRecordingFrameBufferCached } from '../../../utils/recordingFrame';
import { getDecodedFrame } from '../../../utils/thermalFrame';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../../../utils/constants';
import { formatFilmTime, lastFrameIndexOf } from '../../../utils/frameTime';
import { useMappingIndex } from '../hooks';
import { STABLE_MAX_SHIFT_PX, assessStability, stabilitySampleIndices } from '../../../utils/twinStability';
import {
  type VisibleMotion,
  assessVisibleMotion,
  cameraMotionKind,
  neighbourIndex,
  visibleCheckIndices,
} from '../../../utils/twinCameraMotion';
import { grayFromRgba } from '../../../../functions/src/twinRegistration';
import { visibleLuma } from '../../../../functions/src/twinOrbit';
import TwinBuildingViewer, { TwinDeleteButton } from './twinBuildingViewer';
import TwinBuildCompose, { type TwinBuildRequest } from './twinBuildCompose';
import {
  type TwinBuildSource,
  clearTwinBuildDraft,
  clearTwinNoteDraft,
  readTwinBuildDraft,
  twinBuildDraftStamp,
  twinModelLabel,
  updateTwinBuildDraft,
} from './twinModels';
import TwinFramePicker from './twinFramePicker';
import TwinLiveProgress from './twinLiveProgress';
import {
  SAVED_AFTER_STOP,
  type TwinFeed,
  failTwinRun,
  startTwinRun,
  stopTwinRun,
  storeTwinRecord,
  twinBuildStopTitle,
  twinRunStoppable,
  useTwinBuildRun,
} from './twinRun';

/** Parallel Storage reads while sampling frames for the motion gate. */
const FETCH_POOL = 4;
/** A frame's visible photo is drawn this wide before the motion check takes its luma — the width the
 *  server measures it at (TWIN_ORBIT_SHARPNESS_WIDTH in functions/src/index.ts). */
const VISIBLE_CHECK_WIDTH = 240;

// ---------------------------------------------------------------------------------------------------
// The generation: the body of a twinRun.ts run. It reports through `set` and `remark`, throws to fail,
// stops when `signal` fires (the owner's Stop), and writes the record into the store itself so a panel
// that was unmounted meanwhile still finds it.

/**
 * What a recording's twin is built from, the owner's choice on the build form (§40): the whole video — the
 * build checks how the camera moved and takes the frames it needs (§39), the default — or the frames the
 * owner picks in the player, which go to the model as a photo set's photos do. `lead` says what a build
 * does on the card before there is a twin; `hint` is its one line under the choice when the form opens
 * from Regenerate.
 */
const BUILD_SOURCES: { value: TwinBuildSource; label: string; hint: string; lead: string }[] = [
  {
    value: 'video',
    label: 'Automatic',
    hint: 'From the whole video: the build checks how the camera moved and takes the frames it needs.',
    lead: 'From the whole video. The camera-motion check runs first. A camera that stood still: an AI model draws the setup as a 3D scene from the stillest frame. A camera that walked around the subject: the model draws it from several frames, so you can orbit it. Either way the scene is painted with the temperatures the camera measured.',
  },
  {
    value: 'frames',
    label: 'Pick frames',
    hint: 'From the frames you pick: move the player to a frame that shows the subject well and add it.',
    lead: 'From the frames you pick: move the player to a frame that shows the subject well and add it — one per side of the subject, if the camera moved. An AI model reads the subject off those frames and draws it as a 3D scene you can orbit, painted with the temperatures the camera measured.',
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
  await buildFromFrames(experiment, request, frames, timeOf, set, signal, feed);
}

/** The scene-program build from given frames (§40), as the picked-frames build and a still camera's build
 *  (§42) both do it. Names a frame the server refused by `timeOf`. */
async function buildFromFrames(
  experiment: Experiment,
  request: TwinBuildRequest,
  frames: number[],
  timeOf: (frame: number) => string,
  set: (progress: string) => void,
  signal: AbortSignal,
  feed: TwinFeed,
): Promise<void> {
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
 * Build a recording's twin from the frames its camera calls for (§39): the motion gate over the clip's
 * thermal frames, then — when they hold still — the photos of a few frames against the stillest one's
 * (utils/twinCameraMotion). A camera that stood still: the stillest frame alone, as a picked frame (§42).
 * One that moved: analyzeTwinBuilding samples the frames itself. Either way the model writes the scene,
 * with the owner's choice of model and their request, and the record goes to the store.
 */
async function generateRecordingTwin(
  experiment: Experiment,
  request: TwinBuildRequest,
  timeOf: (frame: number) => string,
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
  const buildStill = async () => {
    remark(
      `The camera stood still (drift ≤ ${stability.maxShiftPx} px): building from the stillest frame, at ${timeOf(stability.referenceIndex)}.`,
    );
    await buildFromFrames(experiment, request, [stability.referenceIndex], timeOf, set, signal, feed);
  };
  if (cameraMotionKind(stability, visible) === 'fixed') return buildStill();

  remark(
    stability.stable && visible
      ? `The camera moved around the subject (${visible.moved} of the ${visible.compared} photos compared show it from another standpoint): building from frames around it.`
      : `The camera moved (the picture drifts ${stability.maxShiftPx} px from the stillest frame): building from frames around the subject.`,
  );
  // No line of its own: the Function streams where it is and what the model writes (§28.5).
  set('');
  try {
    storeTwinRecord(experiment.id, await analyzeTwinBuilding(experiment.id, 'orbit', request, signal, feed));
  } catch (e) {
    if (signal.aborted || !isCameraStillRefusal(e)) throw e;
    // The server's own gate — fewer frames, the clip's first and last moments left out — found no walk.
    // A clip the thermal gate passed is a still camera after all; one it failed fits neither kind.
    if (stability.stable) return buildStill();
    throw new Error(
      `The camera moved too much to build from one frame — the picture drifts ${stability.maxShiftPx} px from the stillest frame, more than the ${STABLE_MAX_SHIFT_PX} px (about 4° of pan) a still camera is allowed — yet it never left its standpoint, so there is nothing to walk around either. Keep the phone still (a stand helps), or walk around the subject, and record again; or pick the frames yourself.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------

interface Props {
  experiment: Experiment;
}

const TwinPanel = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  // Read the record off the store so a finished run (which writes there) shows up without a reload.
  const live = useCommonStore((state) => state.experimentMap.get(experiment.id));
  // One field, two kinds of record: the scene program TwinBuildingViewer shows, or a twin from before §42
  // (an object list the panel used to lay out itself), which is only offered for rebuilding.
  const rawRecord = live?.twinScene ?? experiment.twinScene ?? null;
  const record: TwinBuildingRecord | null = rawRecord && isTwinBuildingRecord(rawRecord) ? rawRecord : null;
  const legacy: TwinLegacySceneRecord | null = rawRecord && !isTwinBuildingRecord(rawRecord) ? rawRecord : null;
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

  const { running, building, error: runError, stopped, savedAfterStop, dismiss } = useTwinBuildRun(experiment.id);
  const [clearing, setClearing] = useState(false);

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
  // A frame is named by its time on the player's clock (twinFramePicker), in a build's remarks and errors too.
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
        : generateRecordingTwin(experiment, request, timeOf, set, signal, feed, remark));
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
        const { twinScene: _dropped, ...rest } = cur;
        store.setExperiment(experiment.id, rest as Experiment);
      }
    } catch (e) {
      failTwinRun(experiment.id, e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  };

  // The owner's build form and toolbar (§20), with the build's progress / outcome. Before there is a twin
  // the form is the panel's content (a card). A scene twin has no Regenerate / Clear: its viewer puts Delete
  // on About's title row, and the form then starts from nothing. A twin from before §42 keeps the toolbar —
  // Regenerate… / Stop / Clear — over the notice that it is no longer drawn; Regenerate opens the form in its
  // place, started from that twin's request and model. What a build throws away besides the twin, said
  // beside the button: the revision thread.
  const storedRevisions = legacy?.revisions?.length ?? 0;
  const replaces =
    legacy && storedRevisions
      ? `This replaces the twin and the ${storedRevisions === 1 ? 'revision' : `${storedRevisions} revisions`} made to it.`
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
      // Every build writes a scene program (§42); the form preselects the model of the twin it replaces,
      // when that model is offered.
      kind="program"
      from={legacy}
      request={legacy?.instructions}
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
      {/* The build's steps (frames checked), then what the Function streams of it (§28.5) — under the toolbar
          of a twin on screen; before there is one, the card is the progress (§28.6). */}
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
  const stopButton = building && (
    <Button
      size="small"
      danger
      onClick={stop}
      disabled={!twinRunStoppable(building)}
      title={twinBuildStopTitle(building)}
    >
      Stop
    </Button>
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
  // The toolbar of a twin from before §42: Regenerate… (or the form it opens) / Stop / Clear.
  const legacyControls = (
    <>
      {canGenerate &&
        (composing && !building ? (
          compose('inline')
        ) : (
          <div className="twin-toolbar">
            {hasVisible === false ? <Tooltip title={noPhotos}>{regenerateButton}</Tooltip> : regenerateButton}
            {stopButton}
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
  // A scene twin has no Regenerate / Clear: its viewer puts Delete on About's title row, and under About
  // only a build's Stop and how it went.
  const controls = (
    <>
      {canGenerate && building && <div className="twin-toolbar">{stopButton}</div>}
      {status}
    </>
  );
  const deleteAction = canGenerate && !running ? <TwinDeleteButton onConfirm={clear} loading={clearing} /> : null;

  return (
    <div className="twin-panel">
      {/* A twin from before §42: the toolbar — or the build form Regenerate opens — then the notice, scrolling
          inside the panel. */}
      {legacy && (
        <div className="twin-notice-stack">
          {legacyControls}
          <Alert
            type="info"
            showIcon
            message="This twin is no longer shown"
            description={`It was made the old way — ${twinModelLabel(legacy)} named the objects in frame ${legacy.recordingIndex ?? '?'} and the app placed stand-in shapes for them. Twins are now drawn by the AI model itself${canGenerate ? ': regenerate it to have the model draw this setup.' : '; the owner can regenerate it.'}`}
          />
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
            : 'The owner has not built a digital twin of this recording yet.'}
        </div>
      )}

      {record && (
        <TwinBuildingViewer
          record={record}
          experiment={experiment}
          controls={controls}
          deleteAction={deleteAction}
          source="orbit"
        />
      )}
    </div>
  );
};

export default TwinPanel;
