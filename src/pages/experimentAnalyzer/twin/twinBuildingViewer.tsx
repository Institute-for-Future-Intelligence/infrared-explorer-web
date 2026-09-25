/**
 * The viewer of a SCENE twin — a subject the vision model wrote as a small three.js program
 * (docs/digital-twin-plan.md §17–§18) — shared by the photo-set panel (twinBuildingPanel) and the
 * recording panel's walk-around mode (twinPanel), which each bring their own build toolbar as `controls`.
 * The program runs in a sandboxed frame (twinFrame.ts) spoken to only by postMessage; this component
 * owns the conversation and the three ways of looking at the scene:
 *
 *   Realistic — the model's own colours;
 *   Measured  — the temperatures the camera read, one median per surface the tracing model outlined in
 *               the thermal photos, plus the faces inferred from them. Every face of the model is filled from
 *               the measurements and painted plain (the 'all' fill, the only one offered: a heat map with
 *               grey holes and striped faces in it was not what a viewer wanted to look at). The table comes
 *               from utils/twinSceneThermal after the frame has reported the parts it actually built, and
 *               goes to the frame as a `paint` message. Over it, wherever a thermal photo registered to the
 *               model (a camera fitted to its landmarks, §18.8) sees the model squarely, the frame paints the
 *               photo's own pixels (fading them into the table's value at a steep slant): useTwinProjection
 *               loads the registered photos' frames and they go as a `photos` message;
 *   Simulated — the envelope heat balance of §17.5: what a camera would read under conditions the viewer
 *               chooses, offered for every scene, beside the measured view when there is one (§21).
 *               Every number it is computed from is the viewer's to change (twinSimControls): the
 *               conditions a scenario preset fills in, the wind and the sky, each kind's material.
 *
 * A twin opens on the Realistic view, measured or not (§23). The two thermal views keep their own colour
 * scales: a scenario preset sets the simulated one, the measured one defaults to the table's range.
 * Nothing here persists; the record is the only state.
 * About — the model's description, which AI model wrote it and to what request (§20), the revision thread
 * (twinRevise, §19) where the owner tells the model what is wrong and it rewrites the program, and the
 * host's build toolbar — is the Realistic view's; the thermal views keep their column for temperatures.
 */
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Button, Popconfirm, Segmented, Tooltip } from 'antd';
import { DeleteOutlined, LoadingOutlined } from '@ant-design/icons';
import {
  Experiment,
  TemperatureUnit,
  TwinBuildingRecord,
  TwinFace,
  TwinSelectionItem,
  TwinThermalPhoto,
  TwinThermalSurface,
} from '../../../types';
import useCommonStore from '../../../stores/common';
import { analyzeTwinBuilding } from '../../../services/ai';
import { isStaff } from '../../../utils/staff';
import {
  type SurfaceTable,
  type TwinBuiltMessage,
  type TwinBuiltPart,
  type TwinFill,
  type TwinPaintMessage,
  buildSurfaceTable,
  mergeSampledSurfaces,
  paletteKeyFor,
  paletteLut256,
  photoMatchedPalette,
} from '../../../utils/twinSceneThermal';
import {
  TWIN_PROJECTION_MAX,
  type TwinPhotoPlaces,
  type TwinPhotosMessage,
  type TwinProjectionPhoto,
  photoLabel,
  predatesProjection as predatesProjectionOf,
  registeredPhotos,
  registrationSummary,
  retraceablePhotos,
  validCamera,
} from '../../../utils/twinProjection';
import { isCaptureOrder, normalizePhotoOrder } from '../../../utils/photoOrder';
import {
  SIM_PRESETS,
  type SimKind,
  type SimMaterial,
  type SimMaterials,
  type SimPresetKey,
  type SimScenario,
  defaultMaterials,
  simKindsInScene,
} from '../../../utils/twinSimulation';
import { faceHomographies } from '../../../utils/twinHomography';
import { type TwinSettledRegistration, settleRegistration } from '../../../utils/twinSettleRegistration';
import { type TwinNoteImage } from '../../../utils/noteImages';
import { SELECTION_MAX, validSelectionItem } from '../../../utils/twinSelection';
import { TWIN_FRAME_HTML } from './twinFrame';
import { type TwinSettled, describeSettled, readSettled } from './twinFrameGeometry';
import { TwinRequestNote } from './twinBuildCompose';
import { type TwinModelKey, twinModelOf } from './twinModels';
import TwinRevise from './twinRevise';
import { type TwinFeed, type TwinRun, startTwinRun, storeTwinRecord, useTwinRun } from './twinRun';
import SimulationControls, { ScaleField } from './twinSimControls';
import { useTwinProjection } from './useTwinProjection';

type ViewMode = 'realistic' | 'simulated' | 'measured';
type ScaleRange = [number, number];

/** A scale needs some width to mean anything; both scales hold their ends this far apart, °C. */
const MIN_SCALE_WIDTH = 2;

/** Photos captured further apart than this were not taken under one set of conditions, and their
 *  temperatures should not be read as one heat map. */
const CAPTURE_SPAN_NOTE_MS = 30 * 60_000;

/** How far the measured view reaches beyond the camera's own readings. It is no longer the viewer's
 *  choice (§26.6): every face is filled — the two narrower fills left grey holes and striped faces in
 *  what people look at as a heat map. */
const FILL: TwinFill = 'all';
const FILL_HINT =
  'Every face gets a temperature from the measurements: from comparable surfaces where there are any, else the same class of material facing any way, else the scene as a whole — the ground included. Each face is varied about its value by as much as the camera saw its reading vary.';

/** The newest program contract this frame can run — TWIN_BUILDING_VERSION in functions/src/twinBuilding.ts,
 *  kept in step by hand. A record above it was written by a newer server for a newer frame (the v5 frame,
 *  for one, had no `api.part` and threw on every v6 program): it must not be posted to this frame, and
 *  the failure it would produce is not the model's to regenerate away. */
const SUPPORTED_TWIN_BUILDING_VERSION = 6;

/** A record from the current contract carries a program; earlier ones carried a block list the app
 *  no longer draws. */
const hasProgram = (r: TwinBuildingRecord): r is TwinBuildingRecord & { code: string } =>
  typeof r.code === 'string' && r.code.length > 0;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;

/** How the frame's report of a measured table it could not paint begins — a caveat on the scene, and no
 *  fault of the program's. */
const PAINT_FAILED = 'Painting the measured temperatures failed';
/** What the panel says when the model's program made the viewer frame load another page (§30.3). */
const FRAME_LEFT = "The model's program tried to load another page in the 3D viewer, so the viewer was stopped.";
/** How long a fresh frame has to say 'ready' before the panel says it did not start (§31.1): three comes
 *  from a CDN, which a slow connection may take a while over. */
const FRAME_START_MS = 20000;
const FRAME_SLOW =
  'The 3D viewer did not start within 20 seconds. It loads three.js from cdn.jsdelivr.net, which may be slow or blocked on this network.';

// ---- What the frame reports. The frame runs the model's program with `new Function`; the program cannot
// reach the private port the frame speaks to this page on (§30.2), but what the frame reports is still its
// account of what that program built, so a `built` message is untrusted input: every part is checked field
// by field and a message with one malformed part is dropped whole, rather than letting a malformed shape
// reach the table or the render.
const SIX_FACE_NAMES: ReadonlySet<string> = new Set<TwinFace>(['front', 'back', 'left', 'right', 'top', 'bottom']);
/** Kinds whose reading is an apparent temperature (a reflection, a low emissivity): the server's list. */
const APPARENT_KINDS: ReadonlySet<string> = new Set(['glass', 'metal', 'liquid']);
/** Every thermal pixel a registered photo's camera sees of one (part, face), as the frame read it back
 *  through the model (its `sampled` message, docs §26): the same statistics the server's tracing gives,
 *  as a surface of the table's input. Null when any field is not what the frame writes. */
function validSampledSurface(raw: unknown): TwinThermalSurface | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof o.part !== 'string' || !o.part || typeof o.kind !== 'string' || typeof o.face !== 'string') return null;
  if (!SIX_FACE_NAMES.has(o.face) && o.face !== 'all') return null;
  if (![o.photo, o.n, o.median, o.p10, o.p90, o.min, o.max].every(finite)) return null;
  return {
    part: o.part,
    kind: o.kind,
    face: o.face as TwinFace,
    photo: o.photo as number,
    quad: [],
    n: o.n as number,
    median: o.median as number,
    p10: o.p10 as number,
    p90: o.p90 as number,
    min: o.min as number,
    max: o.max as number,
    ...(o.smallSample === true ? { smallSample: true } : {}),
    ...(o.mixed === true ? { mixed: true } : {}),
    ...(APPARENT_KINDS.has(o.kind) ? { apparent: true } : {}),
    registered: true,
    sampled: true,
  };
}
const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
/** The part as the table expects it, copied field by field (nothing else the message carried rides along),
 *  or null when any field is not what the frame's own describeParts writes. */
function validBuiltPart(p: unknown): TwinBuiltPart | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (
    typeof o.name !== 'string' ||
    !isStringArray(o.kinds) ||
    !isStringArray(o.faces) ||
    !o.faces.every((f) => SIX_FACE_NAMES.has(f)) ||
    !isVec3(o.center) ||
    !isVec3(o.min) ||
    !isVec3(o.max) ||
    typeof o.meshCount !== 'number' ||
    !Number.isFinite(o.meshCount) ||
    typeof o.round !== 'boolean'
  )
    return null;
  return {
    name: o.name,
    kinds: o.kinds,
    faces: o.faces as TwinFace[],
    center: o.center,
    min: o.min,
    max: o.max,
    meshCount: o.meshCount,
    round: o.round,
  };
}

/** The photos the tracing phase could not use, worded by cause (§18.6 C2): the record keeps one status
 *  row per thermal photo, and a run that dropped them all would otherwise look like a set with nothing
 *  to measure. */
function describePhotoFailures(photos: TwinThermalPhoto[], pictureWord: string): string | null {
  const failed = photos.filter((p) => p.status !== 'ok');
  if (!failed.length) return null;
  const count = (ok: (s: TwinThermalPhoto['status']) => boolean) => failed.filter((p) => ok(p.status)).length;
  // A photo the tracing ran out of time for — its call cut off at its deadline, or never started because
  // writing the scene used up the build's time (§20) — is no fault of the tracing model's.
  const outOfTime = failed.filter(
    (p) => p.status === 'model-failed' && /^(timed out|not traced)/.test(p.error ?? ''),
  ).length;
  const modelFailed = count((s) => s === 'model-failed') - outOfTime;
  const unreadable = count((s) => s === 'no-frame' || s === 'unreadable' || s === 'incomplete-frame');
  const aspect = count((s) => s === 'aspect');
  const reasons = [
    ...(outOfTime ? [`the build ran out of time for ${outOfTime}`] : []),
    ...(modelFailed ? [`the tracing model failed on ${modelFailed}`] : []),
    ...(unreadable ? [`the thermal frame of ${unreadable} could not be read`] : []),
    ...(aspect ? [`the picture of ${aspect} did not match the thermal frame's shape`] : []),
  ];
  const head =
    failed.length === photos.length
      ? `None of the ${plural(photos.length, `thermal ${pictureWord}`)} could be traced`
      : `${failed.length} of the ${plural(photos.length, `thermal ${pictureWord}`)} could not be traced`;
  return `${head} (${reasons.join('; ')}).`;
}

/** The owner's Delete on the About title row: a quiet link, confirmed before the twin is removed. */
export const TwinDeleteButton = ({ onConfirm, loading }: { onConfirm: () => void; loading: boolean }) => (
  <Popconfirm
    title="Delete the digital twin?"
    description="Viewers will no longer see it."
    okText="Delete"
    okButtonProps={{ danger: true }}
    onConfirm={onConfirm}
  >
    <Button type="link" size="small" danger icon={<DeleteOutlined />} loading={loading}>
      Delete
    </Button>
  </Popconfirm>
);

/**
 * A failure inside the viewer — a render that throws on what the frame or the record supplied — must not
 * take the whole analyzer page down with it: the boundary shows the error with the host's toolbar under
 * it, so the owner can still delete it, and tries again when another record arrives.
 */
interface SceneBoundaryProps {
  record: TwinBuildingRecord;
  controls: ReactNode;
  deleteAction?: ReactNode;
  children: ReactNode;
}
class SceneBoundary extends Component<SceneBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('twin viewer failed', error, info.componentStack);
  }

  componentDidUpdate(prev: SceneBoundaryProps): void {
    if (this.state.error && prev.record !== this.props.record) this.setState({ error: null });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="twin-notice-stack">
        <Alert
          type="error"
          showIcon
          message="The digital twin could not be shown"
          description={this.state.error.message || 'The viewer failed while drawing this twin.'}
        />
        {this.props.deleteAction && <div className="twin-toolbar">{this.props.deleteAction}</div>}
        {this.props.controls}
      </div>
    );
  }
}

/**
 * What stands in for the scene when the record cannot be viewed: the model declined (blocker), or the
 * record predates the program contract (stale).
 */
const Notices = ({ record, canRegenerate }: { record: TwinBuildingRecord; canRegenerate: boolean }) => {
  const stale = !hasProgram(record) && !record.blocker;
  return (
    <>
      {record.blocker && (
        <Alert
          type="warning"
          showIcon
          message="Not rendered"
          description={`${record.blocker}${record.reason && record.reason !== record.blocker ? ` (${record.reason})` : ''}`}
        />
      )}
      {stale && (
        <Alert
          type="info"
          showIcon
          message="Built with an earlier analysis"
          description={
            canRegenerate
              ? 'This twin was made by the earlier block-based analysis, which the app no longer draws. Delete it and build it again as a scene.'
              : 'This twin was made by an earlier analysis the app no longer draws; the owner can rebuild it.'
          }
        />
      )}
    </>
  );
};

export interface TwinBuildingViewerProps {
  record: TwinBuildingRecord;
  experiment: Experiment;
  /** The host's build toolbar with its progress and errors; closes the About section at the foot of the
   *  settings column, in the Realistic view (or, when there is no scene to show, follows the notice that
   *  says so). */
  controls: ReactNode;
  /** The owner's Delete (with its confirmation): on the About title row, right-aligned — or, when there is no
   *  scene to show, above the host's toolbar under the notice. Absent for a reader. */
  deleteAction?: ReactNode;
  /** What the pictures were: a photo set's photos, or frames sampled from a walk-around recording. */
  source: 'photos' | 'orbit';
}

/**
 * The record's scene, or — when it has no program to run (the model declined, or the record predates
 * the program contract) — the notice that says so with the host's toolbar under it. The scene proper is
 * its own component so that its frame and everything read from the frame start afresh whenever a scene
 * appears.
 */
const TwinBuildingViewer = ({ record, experiment, controls, deleteAction, source }: TwinBuildingViewerProps) => {
  const user = useCommonStore((state) => state.user);
  // Only for the wording of notices ("Regenerate…" vs "the owner can…"); the toolbar is the host's.
  const canRegenerate = !!user && user.id === experiment.ownerId && isStaff(user);
  // Checked before anything else: a newer record's program would fail in this frame, and the failure
  // alert would wrongly invite a regeneration — the fix is a newer app, which a reload fetches.
  // With no scene to show, the notice and the toolbar under it — which Regenerate turns into the build
  // form — scroll inside the panel (.twin-notice-stack), so a short workspace does not clip the form.
  if (record.version > SUPPORTED_TWIN_BUILDING_VERSION) {
    return (
      <div className="twin-notice-stack">
        <Alert
          type="info"
          showIcon
          message="Built with a newer analysis"
          description="This twin was made by a newer analysis than this copy of the app can draw — reload the app to view it."
        />
        {deleteAction && <div className="twin-toolbar">{deleteAction}</div>}
        {controls}
      </div>
    );
  }
  if (!hasProgram(record) || record.blocker) {
    return (
      <div className="twin-notice-stack">
        <Notices record={record} canRegenerate={canRegenerate} />
        {deleteAction && <div className="twin-toolbar">{deleteAction}</div>}
        {controls}
      </div>
    );
  }
  return (
    <SceneBoundary record={record} controls={controls} deleteAction={deleteAction}>
      <SceneView
        record={record}
        code={record.code}
        experiment={experiment}
        controls={controls}
        deleteAction={deleteAction}
        source={source}
        canRegenerate={canRegenerate}
      />
    </SceneBoundary>
  );
};

interface SceneViewProps extends TwinBuildingViewerProps {
  code: string;
  canRegenerate: boolean;
}

const SceneView = ({ record, code, experiment, controls, deleteAction, source, canRegenerate }: SceneViewProps) => {
  const unit = useCommonStore((state) => state.temperatureUnit);
  const unitKey = unit === TemperatureUnit.fahrenheit ? 'F' : 'C';
  const pictureWord = source === 'orbit' ? 'frame' : 'photo';
  // A set's photos are called by their places on the strip — the owner's viewing order, which a drag
  // changes — while the record keys them by stored number (§31.3): each photo's place, when the order is
  // not the capture order.
  const photoPlaces: TwinPhotoPlaces | null = useMemo(() => {
    if (source !== 'photos') return null;
    const count = Math.max(0, Math.floor(experiment.photoCount ?? 0));
    const order = normalizePhotoOrder(experiment.photoOrder, count);
    return isCaptureOrder(order) ? null : new Map(order.map((slot, place) => [slot + 1, place + 1]));
  }, [source, experiment.photoCount, experiment.photoOrder]);
  // A revision builds on a program of the current contract (the server refuses older ones: they have no
  // named parts to keep); anything older is regenerated instead.
  const canRevise = canRegenerate && record.version === SUPPORTED_TWIN_BUILDING_VERSION;
  const ownerViewing = useCommonStore((state) => !!state.user && state.user.id === experiment.ownerId);
  // A build or a revision in flight: its progress and Stop sit in About, which only the Realistic view
  // shows, so the thermal views say where to follow it.
  const run = useTwinRun(experiment.id);
  const liveRun = run && !run.done ? run : null;

  // ---- The frame: an iframe with no origin, spoken to only by postMessage.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);
  // A caveat on a scene that did build: the program stopped part-way, or its measured table could not be
  // painted. Shown as a note beside the scene, never as the build having failed.
  const [frameWarning, setFrameWarning] = useState<string | null>(null);
  // What the frame set down after the last build, and which roofs leave walls bare (§29), in words.
  const [frameSettled, setFrameSettled] = useState<string | null>(null);
  // What the frame built, tagged with the program it ran: a `built` report for the previous program must
  // not be read against the current record while the frame is still rebuilding. Every `build` carries a
  // build id the frame echoes in its `built` and `error`, so a report is matched to the program the frame
  // actually ran — not to whatever program is current when the report arrives — and a late report for a
  // superseded build is dropped. The code tag comes from the same place the id was issued, the build
  // effect, so a render with a new record shows no `built` until the frame has answered for it.
  // `settled` is what the frame set down (§29): the photos' landmarks follow it (twinSettleRegistration).
  const [builtState, setBuiltState] = useState<{
    code: string;
    built: TwinBuiltMessage;
    settled: TwinSettled | null;
  } | null>(null);
  const built = builtState && builtState.code === code ? builtState.built : null;
  const builtSettled = builtState && builtState.code === code ? builtState.settled : null;
  // The surfaces the frame read back through the model from the registered photos (§26): each stands in
  // for the traced reading of the same photo, part and face in the table's input; a face the frame could
  // not read keeps its traced one (mergeSampledSurfaces, §30.5). A build's samples belong to its program,
  // as its parts do.
  const [sampledState, setSampledState] = useState<{ code: string; surfaces: TwinThermalSurface[] } | null>(null);
  const sampled = sampledState && sampledState.code === code ? sampledState.surfaces : null;
  const thermalForTable = useMemo(() => {
    if (!record.thermal || !sampled || !sampled.length) return record.thermal;
    return { ...record.thermal, surfaces: mergeSampledSurfaces(record.thermal.surfaces, sampled) };
  }, [record.thermal, sampled]);
  const sentBuild = useRef<{ id: number; code: string }>({ id: 0, code: '' });
  // The probe: always there in the thermal views — hover the model for the surface temperature under the
  // pointer, click to pin a reading. The frame keeps the pins; the panel only knows how many, to offer a
  // Clear.
  const [pinned, setPinned] = useState(0);
  // The private channel to the frame (twinFrame.ts header, §30.2): handed to it once, in answer to its
  // 'ready', before any program has run there. Everything goes over it, both ways.
  const portRef = useRef<MessagePort | null>(null);
  const post = useCallback((msg: object) => {
    portRef.current?.postMessage(msg);
  }, []);

  // What the owner has selected by clicks in the frame's realistic view (each click adds the face or mesh
  // under it, or takes a selected one out; the frame's highlight and hint show what, and the note box
  // says only how many, §28.4/§28.7) — which the note goes to the model with (§28). A rebuild drops it:
  // the parts and meshes may have changed. (The frame also takes a `select` message, should a host ever set the selection itself.)
  const [selectedItems, setSelectedItems] = useState<TwinSelectionItem[]>([]);
  useEffect(() => {
    setSelectedItems([]);
  }, [code]);
  // A picture of the view as the frame draws it, to attach to a note (§28): asked for by id, answered by
  // message; null when the frame does not answer in time (a frame from before the message ignores it).
  const snapshotWaiters = useRef(new Map<number, (url: string | null) => void>());
  const snapshotId = useRef(0);
  const captureView = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        const id = ++snapshotId.current;
        snapshotWaiters.current.set(id, resolve);
        post({ type: 'snapshot', id });
        window.setTimeout(() => {
          if (snapshotWaiters.current.delete(id)) resolve(null);
        }, 4000);
      }),
    [post],
  );
  // ---- One frame document per program (§30.3). A program's timers and listeners live as long as its
  // document, so the frame is replaced whenever the program changes (the build effect bumps frameGen, the
  // iframe's key, and the fresh frame's 'ready' brings the build): whatever a frame does can then only be
  // the doing of the one program it ran, frameProgram.
  const [frameGen, setFrameGen] = useState(0);
  const frameProgram = useRef<string | null>(null);
  // The frame leaving: a sandboxed frame may navigate itself, which no CSP stops. It says so as it goes
  // ('leaving', from pagehide), and a second load of the element or a second 'ready' catch it otherwise.
  // The frame is taken down (its port closed, the element unmounted, whatever it reported dropped) with
  // a notice while its program is the one on show; the next program gets a fresh frame.
  const [leftFrameCode, setLeftFrameCode] = useState<string | null>(null);
  const frameLoads = useRef(new WeakMap<HTMLIFrameElement, number>());
  // A frame that could not start (§31.1): it said why ('failed'), or it said nothing in FRAME_START_MS. Shown
  // over the canvas with a way to try again, until the frame does say 'ready' (a slow CDN gets there late).
  const [frameFailed, setFrameFailed] = useState<string | null>(null);
  // The frame elements that have been handed the port: a 'failed' from one of them is not the frame's.
  const portedFrames = useRef(new WeakSet<HTMLIFrameElement>());
  const takeFrameDown = useCallback(() => {
    portRef.current?.close();
    portRef.current = null;
    setFrameReady(false);
    // The panel must not go on describing a viewer that is gone.
    setBuiltState(null);
    setSampledState(null);
    setFrameSettled(null);
    setFrameWarning(null);
    setSelectedItems([]);
    setPinned(0);
    for (const take of snapshotWaiters.current.values()) take(null);
    snapshotWaiters.current.clear();
    setFrameFailed(null);
    const culprit = frameProgram.current;
    frameProgram.current = null;
    if (culprit === null) {
      // No program ran in it, so there is nothing to blame: only a frame to replace.
      setFrameGen((g) => g + 1);
      return;
    }
    setLeftFrameCode(culprit);
    setFrameError(FRAME_LEFT);
  }, []);
  const onFrameLoad = useCallback(
    (e: SyntheticEvent<HTMLIFrameElement>) => {
      const el = e.currentTarget;
      const loads = (frameLoads.current.get(el) ?? 0) + 1;
      frameLoads.current.set(el, loads);
      if (loads > 1) takeFrameDown();
    },
    [takeFrameDown],
  );
  const frameDown = leftFrameCode !== null && leftFrameCode === code;
  useEffect(() => {
    if (leftFrameCode !== null && leftFrameCode !== code) {
      setLeftFrameCode(null);
      setFrameError(null);
    }
  }, [code, leftFrameCode]);
  useEffect(() => {
    if (frameReady || frameDown || frameFailed) return;
    const timer = window.setTimeout(() => setFrameFailed(FRAME_SLOW), FRAME_START_MS);
    return () => window.clearTimeout(timer);
  }, [frameGen, frameReady, frameDown, frameFailed]);
  const retryFrame = () => {
    setFrameFailed(null);
    setFrameGen((g) => g + 1);
  };
  useEffect(() => {
    // What the frame may send (built / error / probes / sampled / selected / snapshot), every field
    // optional: a frame a version behind or ahead of this panel must not break it. It comes over the
    // private port, which the model's program cannot reach — but it is still the frame's account of a
    // program's output, so nothing here is taken on trust (see validBuiltPart).
    interface FrameMessage {
      type?: string;
      buildId?: unknown;
      message?: unknown;
      warning?: unknown;
      count?: unknown;
      meshes?: unknown;
      parts?: unknown;
      unnamedMeshes?: unknown;
      size?: unknown;
      settled?: unknown;
      surfaces?: unknown;
      items?: unknown;
      id?: unknown;
      dataUrl?: unknown;
    }
    const finiteOr = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const onMessage = (e: MessageEvent) => {
      const d = e.data as FrameMessage | null;
      if (!d || typeof d !== 'object') return;
      // A report for a build this panel has since superseded; a frame too old to echo the id is
      // taken at its word, as before.
      const superseded = typeof d.buildId === 'number' && d.buildId !== sentBuild.current.id;
      if (d.type === 'built') {
        if (superseded) return;
        const parts: TwinBuiltPart[] = [];
        for (const raw of Array.isArray(d.parts) ? d.parts : []) {
          const part = validBuiltPart(raw);
          if (!part) {
            // Dropped whole, as ever — but said, so the panel does not sit waiting for a report (§31.7).
            console.warn('twin: dropped a built report with a malformed part', raw);
            setBuiltState(null);
            setFrameError('The 3D viewer described a part of the model in a way the panel cannot read.');
            return;
          }
          parts.push(part);
        }
        const settled = readSettled(d.settled);
        setBuiltState({
          code: sentBuild.current.code,
          built: {
            type: 'built',
            meshes: finiteOr(d.meshes, 0),
            parts,
            unnamedMeshes: finiteOr(d.unnamedMeshes, 0),
            size: finiteOr(d.size, 0),
          },
          settled,
        });
        setFrameError(null);
        // A program that threw part-way still built something: the frame shows that and says where it
        // stopped, which is a caveat on the scene, not a failure of it.
        setFrameWarning(typeof d.warning === 'string' && d.warning ? d.warning : null);
        setFrameSettled(describeSettled(settled));
      } else if (d.type === 'error') {
        if (superseded) return;
        const message = typeof d.message === 'string' && d.message ? d.message : 'The program failed.';
        // The frame reports a table it could not paint separately from the build, after 'built': the
        // scene stands, only the measured view is missing.
        if (message.startsWith(PAINT_FAILED)) setFrameWarning(message);
        else {
          // A build that failed — or one that built and then could not be drawn, which the frame dropped
          // (§31.1): nothing of it stands to be described.
          setFrameError(message);
          setFrameSettled(null);
          setBuiltState(null);
          setSampledState(null);
        }
      } else if (d.type === 'leaving') takeFrameDown();
      else if (d.type === 'probes') setPinned(finiteOr(d.count, 0));
      else if (d.type === 'selected') {
        // A click in the frame changed the selection (§28); each item is checked for shape — the server
        // checks the parts against the model's when a note goes.
        const items: TwinSelectionItem[] = [];
        for (const raw of Array.isArray(d.items) ? d.items : []) {
          const item = validSelectionItem(raw);
          if (item && items.length < SELECTION_MAX) items.push(item);
        }
        setSelectedItems(items);
      } else if (d.type === 'snapshot') {
        const take = typeof d.id === 'number' ? snapshotWaiters.current.get(d.id) : undefined;
        if (take) {
          snapshotWaiters.current.delete(d.id as number);
          take(typeof d.dataUrl === 'string' && d.dataUrl.startsWith('data:image/') ? d.dataUrl : null);
        }
      } else if (d.type === 'sampled') {
        if (superseded) return;
        const surfaces: TwinThermalSurface[] = [];
        for (const raw of Array.isArray(d.surfaces) ? d.surfaces : []) {
          const surface = validSampledSurface(raw);
          if (surface) surfaces.push(surface);
        }
        setSampledState({ code: sentBuild.current.code, surfaces });
      }
    };
    // The frame's one message on the window: 'ready', answered with the port. Only the first is: a second
    // would come from a new document in the frame, which may not be ours.
    const onWindowMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
      const d = e.data as FrameMessage | null;
      if (!d || typeof d !== 'object') return;
      // The frame could not start (§31.1) — heard only from a frame element that has never been handed the
      // port (§31.7): once it has, a program may have run there, and the window is where it could say
      // anything — even after it said 'ready' again and the frame was taken down.
      if (d.type === 'failed') {
        if (!portRef.current && !portedFrames.current.has(frame)) {
          const why =
            typeof d.message === 'string' && d.message
              ? d.message.slice(0, 300).replace(/[.\s]+$/, '')
              : 'an unknown error';
          setFrameFailed(`The 3D viewer could not start: ${why}.`);
        }
        return;
      }
      if (d.type !== 'ready') return;
      if (portRef.current) {
        takeFrameDown();
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = onMessage;
      portRef.current = channel.port1;
      portedFrames.current.add(frame);
      frameProgram.current = null; // a fresh frame: no program has run in it
      frame.contentWindow.postMessage({ type: 'connect' }, '*', [channel.port2]);
      setFrameReady(true);
      setFrameFailed(null);
    };
    window.addEventListener('message', onWindowMessage);
    return () => {
      window.removeEventListener('message', onWindowMessage);
      portRef.current?.close();
      portRef.current = null;
      // The frame has said 'ready' once and will not again: should this effect run again (a hot update in
      // development), it needs a fresh frame to hand a port to.
      setFrameReady(false);
      setFrameGen((g) => g + 1);
    };
  }, [takeFrameDown]);

  // ---- The measured table: the traced surfaces matched to the parts the frame actually built. A table
  // that cannot be built (a record shape the util does not expect) costs the measured view, not the page.
  // The fill is always 'all' (§26.6): every face carries a value and nothing is grey or striped. The
  // orientation check reads the phase-1 views, even for a photo registered to the model: the tracer named its
  // faces from the viewpoint sentence those views were worded into, so they are what its names are relative
  // to — and a fitted camera, which lines up with the model's geometry, can stand where the model's own
  // (wrong) side hides a side the photo really shows, and would veto surfaces the tracer outlined in the
  // picture.
  const table: SurfaceTable | null = useMemo(() => {
    if (!built) return null;
    try {
      return buildSurfaceTable(
        thermalForTable,
        built.parts,
        record.views,
        record.subjectKind,
        unitKey,
        source,
        FILL,
        photoPlaces,
      );
    } catch (e) {
      console.warn('twin: the measured table could not be built', e);
      return null;
    }
  }, [built, thermalForTable, record.views, record.subjectKind, unitKey, source, photoPlaces]);
  const measuredOffered = !!table && table.entries.some((e) => e.status === 'measured');
  // Windows are painted colder than their wall (a pane reflects the sky) only where the program built them
  // as glass meshes; a scene of a building without a single one has its windows drawn as wall.
  const hasGlass = !!built && built.parts.some((p) => p.kinds.includes('glass'));
  const windowsNote =
    built && !hasGlass && (record.subjectKind === 'building' || record.subjectKind === 'interior')
      ? `No window is modelled as glass, so none can be painted colder than its wall. In the Realistic view, tell the AI: "model every window as its own thin glass box".`
      : null;
  // ---- The projection (§18.8): the thermal frames of the photos registered to the model, which the frame
  // paints over the table wherever a photo's camera sees the model squarely. The frames load after the
  // record arrives; until they do, and when none loads, the table alone paints. The subject's kind says
  // whether the frames have a sky to cut away (a room has none).
  const projection = useTwinProjection(experiment.recordingId, record.thermal, pictureWord, record.subjectKind);
  const registration = useMemo(
    () => registrationSummary(record.thermal, pictureWord, photoPlaces),
    [record.thermal, pictureWord, photoPlaces],
  );
  // Each photo as the frame is to project it, once the frame has built the model. Its camera follows what
  // the frame set down (§29, §30.1): the stored camera was fitted to the program as written, so when the
  // frame moved parts of it, the photo's landmarks move with them and the camera is moved or fitted again
  // (settleRegistration); a photo whose landmarks no longer agree on one camera is left out, and its traced
  // surfaces stand. Then its per-face homographies (§26), fitted to those landmarks against the parts the
  // frame built: a face with four landmarks of its own projects through them, corner to corner.
  // A photo's settled registration is a camera fit (RANSAC and all) when parts moved by different amounts:
  // kept per photo and inputs, so a new record object with the same content, or the frames loading after
  // the build report, reuse it rather than fit again.
  const settleCache = useRef(new Map<string, TwinSettledRegistration>());
  const { photosToSend, refusedPhotos } = useMemo((): {
    photosToSend: TwinProjectionPhoto[];
    refusedPhotos: { photo: number; label: string; reason: string }[];
  } => {
    // Named as the strip names them, for the probe (§31.3).
    const named = photoPlaces
      ? projection.photos.map((p) => ({ ...p, label: photoLabel(p.photo, pictureWord, photoPlaces) }))
      : projection.photos;
    if (!built || !record.thermal) return { photosToSend: named, refusedPhotos: [] };
    const byPhoto = new Map(record.thermal.photos.map((p) => [p.photo, p]));
    const out: TwinProjectionPhoto[] = [];
    const refused: { photo: number; label: string; reason: string }[] = [];
    const settleKey = builtSettled ? JSON.stringify([builtSettled.shifts, builtSettled.split]) : '';
    for (const p of named) {
      const thermalPhoto = byPhoto.get(p.photo);
      const stored = thermalPhoto ? validCamera(thermalPhoto.camera) : null;
      if (!thermalPhoto || !stored) {
        out.push(p);
        continue;
      }
      const key = JSON.stringify([p.photo, stored, thermalPhoto.landmarks ?? [], settleKey]);
      let settled = settleCache.current.get(key);
      if (!settled) {
        settled = settleRegistration(thermalPhoto, stored, builtSettled);
        if (settleCache.current.size > 64) settleCache.current.clear();
        settleCache.current.set(key, settled);
      }
      if (!settled.camera) {
        refused.push({ photo: p.photo, label: p.label, reason: settled.reason });
        continue;
      }
      const camera = settled.camera;
      const moved =
        settled.how === 'unchanged'
          ? null
          : {
              position: [camera.position[0], camera.position[1], camera.position[2]] as [number, number, number],
              yaw: camera.yaw,
              pitch: camera.pitch,
              roll: camera.roll,
              fovV: camera.fovV,
              aspect: camera.aspect,
              rms: camera.rms,
            };
      const homographies = faceHomographies({ landmarks: settled.landmarks }, camera, built.parts);
      out.push({ ...p, ...moved, ...(homographies.length ? { homographies } : {}) });
    }
    return { photosToSend: out, refusedPhotos: refused };
  }, [projection.photos, built, builtSettled, record.thermal, photoPlaces, pictureWord]);
  const registered = useMemo(() => registeredPhotos(record.thermal), [record.thermal]);

  // ---- The view mode. The simulation is offered for every scene, measured or not (§21): it is a what-if
  // set beside the readings, never in their place, and it no longer waits on the subject's kind — the
  // model's guess, which a revision can change (a house re-answered as 'other' lost the view with it).
  // The viewer's choice stands while it is offered; otherwise — and until a choice is made — the twin
  // opens on the realistic look, measured or not: what the scene is comes before what it read, and the
  // thermal views are one tab away. Deriving the mode (rather than clamping it in an effect) means no
  // render ever posts a mode the frame cannot show.
  const [chosenMode, setChosenMode] = useState<ViewMode | null>(null);
  const offered: ViewMode[] = ['realistic', ...(measuredOffered ? (['measured'] as ViewMode[]) : []), 'simulated'];
  const mode: ViewMode = chosenMode && offered.includes(chosenMode) ? chosenMode : 'realistic';

  // ---- The simulated view's conditions, scale and materials: a preset fills in the first two, and the
  // viewer changes any of the three after; the materials start as the twin's defaults.
  const [presetKey, setPresetKey] = useState<SimPresetKey>('winterNight');
  const [scenario, setScenario] = useState<SimScenario>(SIM_PRESETS.winterNight.scenario);
  const [simRange, setSimRange] = useState<ScaleRange>(SIM_PRESETS.winterNight.range);
  const [materials, setMaterials] = useState<SimMaterials>(defaultMaterials);
  // The materials table starts folded and stays as the viewer left it: the whole Simulation section
  // unmounts on a trip to the Measured view, so its own state would re-fold the table on the way back.
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const choosePreset = (k: SimPresetKey) => {
    setPresetKey(k);
    setScenario(SIM_PRESETS[k].scenario);
    setSimRange(SIM_PRESETS[k].range);
  };
  const changeScenario = (patch: Partial<SimScenario>) => setScenario((s) => ({ ...s, ...patch }));
  const changeMaterial = (kind: SimKind, patch: Partial<SimMaterial>) =>
    setMaterials((m) => ({ ...m, [kind]: { ...m[kind], ...patch } }));
  // The kinds the model's surfaces are painted as, for the materials table: those of its parts, and the
  // ground plane's unless the scene is a room (whose floor is the program's).
  const simKinds = useMemo(
    () =>
      built
        ? simKindsInScene(
            built.parts.flatMap((p) => p.kinds),
            record.subjectKind !== 'interior',
          )
        : [],
    [built, record.subjectKind],
  );

  // ---- The measured view's scale: the table's range until the viewer drags the handles, and again the
  // table's after a regeneration (a new record) — a unit change keeps the handles where they are.
  const [measuredOverride, setMeasuredOverride] = useState<{ record: TwinBuildingRecord; range: ScaleRange } | null>(
    null,
  );
  // ---- The measured view's colours (§26): one registered photo's own — its render's histogram
  // equalisation over its own range, so the model shows the photo's colours for the same temperatures,
  // the sky's included — or the palette stretched over the scale. A photo while one is loaded (the first
  // registered one to begin with); dragging the scale's handles switches to the scale.
  const [colours, setColours] = useState<{ record: TwinBuildingRecord; source: 'scale' | number } | null>(null);
  // A photo left out once the model was set down (refusedPhotos) is not projected, so it is not offered.
  // In the strip's order, under the strip's numbers (§31.3); the value stays the stored number.
  const placeOf = useCallback((n: number) => photoPlaces?.get(n) ?? n, [photoPlaces]);
  const matchable = useMemo(
    () =>
      registered
        .map((r) => r.photo.photo)
        .filter((n) => projection.agc.has(n) && !refusedPhotos.some((x) => x.photo === n))
        .sort((a, b) => placeOf(a) - placeOf(b)),
    [registered, projection.agc, refusedPhotos, placeOf],
  );
  const chosenColours = colours && colours.record === record ? colours.source : null;
  // Until the viewer chooses, the colours follow the picture the player beside the twin is showing (a
  // set's photo number is its 1-based index; a recording's frame index is the number itself), so what
  // is on the left and what is on the right agree; the first matchable photo when that one is not.
  const shownPicture = useCommonStore((state) => state.playerRecordingIndex);
  const colourSource: 'scale' | number =
    chosenColours !== null && (chosenColours === 'scale' || matchable.includes(chosenColours))
      ? chosenColours
      : shownPicture !== null && matchable.includes(shownPicture)
        ? shownPicture
        : (matchable[0] ?? 'scale');
  // The sky behind the model: the followed photo's own reading, else the median across the photos.
  const skyPaint = useMemo(() => {
    const own = colourSource === 'scale' ? undefined : projection.sky.get(colourSource);
    if (own) return { tempC: own.median, coldC: own.cold, warmC: own.warm };
    const all = [...projection.sky.values()];
    if (!all.length) return null;
    const mid = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1];
    return {
      tempC: mid(all.map((s) => s.median)),
      coldC: mid(all.map((s) => s.cold)),
      warmC: mid(all.map((s) => s.warm)),
    };
  }, [colourSource, projection.sky]);
  const matched = colourSource === 'scale' ? null : (projection.agc.get(colourSource) ?? null);
  // Keyed on the palette name, not the experiment object: a store update must not repaint the scene. The
  // photo the colours follow brings its own palette in a set whose photos differ (§31.6).
  const paletteKey = paletteKeyFor(experiment, source === 'photos' && matched ? (colourSource as number) : null);
  const palette = useMemo(() => paletteLut256(paletteKey), [paletteKey]);
  const measuredRange = useMemo<ScaleRange | null>(
    () =>
      matched
        ? [matched.min, matched.max]
        : measuredOverride && measuredOverride.record === record
          ? measuredOverride.range
          : (table?.range ?? null),
    [matched, measuredOverride, record, table],
  );
  const paintPalette = useMemo(
    () => (matched ? photoMatchedPalette(palette, matched.map) : palette),
    [palette, matched],
  );
  const scaleBounds: ScaleRange | null =
    table && measuredRange
      ? [Math.min(table.sliderBounds[0], measuredRange[0]), Math.max(table.sliderBounds[1], measuredRange[1])]
      : null;

  // ---- Talking to the frame. Build when the program or the frame changes; the mode, scenario and scale
  // travel with the build and their own effect covers later changes; the paint table follows the build
  // report and can never precede it (it is computed from it).
  useEffect(() => {
    if (!frameReady) return;
    // A frame runs one program (§30.3): a new program gets a fresh frame, whose 'ready' comes back here.
    if (frameProgram.current !== null && frameProgram.current !== code) {
      portRef.current?.close();
      portRef.current = null;
      setFrameReady(false);
      setFrameGen((g) => g + 1);
      return;
    }
    if (frameProgram.current === code) return;
    frameProgram.current = code;
    setBuiltState(null);
    setFrameError(null);
    setFrameWarning(null);
    sentBuild.current = { id: sentBuild.current.id + 1, code };
    post({
      type: 'build',
      buildId: sentBuild.current.id,
      code,
      mode,
      scenario,
      range: simRange,
      materials,
      unit: unitKey,
      // With their kinds, for the parts a program builds as raw THREE groups named after them (§30.6).
      parts: (record.parts ?? []).map((p) => ({ name: p.name, kind: p.kind })),
      subjectKind: record.subjectKind ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameReady, code, post]);
  // The projected photos follow every build's report — their cameras depend on what the frame set down,
  // so sending them before would project from cameras about to change (and redo the frame's depth and ID
  // passes for nothing) — and go again whenever they change: as none at all for a record without
  // registered photos, so a previous record's photos never outlast its model's report.
  useEffect(() => {
    if (!frameReady || !built) return;
    const msg: TwinPhotosMessage = { type: 'photos', photos: photosToSend };
    post(msg);
  }, [frameReady, code, built, photosToSend, post]);
  useEffect(() => {
    if (!frameReady) return;
    post({ type: 'mode', mode, scenario, range: simRange, materials, unit: unitKey });
  }, [frameReady, code, mode, scenario, simRange, materials, unitKey, post]);
  useEffect(() => {
    if (!frameReady || !built || !table || !measuredRange) return;
    const msg: TwinPaintMessage = {
      type: 'paint',
      entries: table.entries,
      lo: measuredRange[0],
      hi: measuredRange[1],
      palette: paintPalette,
      measuredOnly: false,
      stripes: false,
      variation: table.variation,
      glassOffset: table.glassOffset,
      ground: table.ground,
      sky: skyPaint,
    };
    post(msg);
  }, [frameReady, code, built, table, measuredRange, paintPalette, skyPaint, post]);
  // The probe reads temperatures, so it has nothing to say about the realistic look; in both thermal
  // views it is simply on (the frame also holds it off while measured mode still wears the realistic look).
  const probeActive = mode !== 'realistic';
  useEffect(() => {
    if (!frameReady) return;
    post({ type: 'probe', on: probeActive });
  }, [frameReady, code, probeActive, post]);
  const clearPins = () => post({ type: 'probe', on: probeActive, clear: true });

  // ---- Wording.
  const thermalSurfaces = record.thermal?.surfaces.length ?? 0;
  // The tracing model named surfaces but none reached the model. The table says why: when every traced
  // surface named a part the program never built, the names in the answer and in the code drifted apart,
  // which only a new answer can mend; otherwise the surfaces were dropped for facing away from their
  // camera, or landed on faces the scene did not build, and the count is reported without a cause it
  // cannot be sure of. Shown outside the measured view, which is not offered without a measurement.
  const nothingPlaced = !!table && table.stats.measured === 0 && thermalSurfaces > 0;
  const namesDrifted = nothingPlaced && table.stats.rejectedNoPart >= thermalSurfaces;
  // About — the model's description, the revision dialog and the build toolbar — belongs to the Realistic
  // view: the thermal views are for reading temperatures. A hint that sends the owner to start over or to
  // the note box says where they are when they are not on screen.
  const onRealistic = mode === 'realistic';
  // There is no Regenerate button any more: starting over is deleting the twin (About's title row) and
  // building it again.
  const regenerate = onRealistic
    ? 'Delete it and build it again'
    : 'In the Realistic view, delete it and build it again';
  // The photos a model call brought nothing back for — failed, timed out, never made for want of the build's
  // time (§32) — traced again on the model as it stands: no new program, and its thread kept. Offered after
  // the note on the tracing (About) for the photos whose surfaces were lost, and after "Not registered"
  // (Measured) for the ones left without a camera.
  const retraceable = useMemo(() => (canRevise ? retraceablePhotos(record.thermal) : []), [canRevise, record.thermal]);
  const retraceRows = (record.thermal?.photos ?? []).filter((p) => retraceable.includes(p.photo));
  const retraceSurfaces = retraceRows.some((p) => p.status === 'model-failed');
  const retraceCameras = retraceRows.some((p) => !validCamera(p.camera));
  const retrace = () => {
    const photos = retraceable;
    startTwinRun(
      experiment.id,
      async (_set, signal, feed) => {
        storeTwinRecord(
          experiment.id,
          await analyzeTwinBuilding(experiment.id, source, { retrace: photos }, signal, feed),
        );
      },
      null,
      true,
    );
  };
  const retraceButton =
    retraceable.length > 0 ? (
      <Button
        type="link"
        size="small"
        className="twin-inline-link"
        onClick={retrace}
        disabled={!!liveRun}
        title={`Trace ${retraceable.map((n) => photoLabel(n, pictureWord, photoPlaces)).join(', ')} again: the AI model outlines the surfaces and places the landmarks anew — the model itself and its revisions stay as they are`}
      >
        Trace again
      </Button>
    ) : null;
  // The photos the tracing phase dropped, and a set that traced nothing — otherwise a run that lost
  // every thermal photo looks like a set with nothing to measure.
  const thermalNote = useMemo(() => {
    const thermal = record.thermal;
    if (!thermal) return null;
    const failures = describePhotoFailures(thermal.photos, pictureWord);
    if (!failures && thermal.surfaces.length > 0) return null;
    const survivors = thermal.photos.filter((p) => p.status === 'ok').length;
    const sentences: string[] = [];
    if (failures) sentences.push(failures);
    if (thermal.surfaces.length === 0) {
      if (survivors > 0)
        sentences.push(
          failures
            ? `The ${plural(survivors, pictureWord)} that survived measured no surface.`
            : `The tracing model outlined no surface in the ${plural(survivors, `thermal ${pictureWord}`)}.`,
        );
      else if (!thermal.photos.length) sentences.push(`No ${pictureWord} carried a thermal frame to trace.`);
    }
    // Only worth a retry when the model had thermal frames to work on — and when the build only ran out of
    // time for them (§20), with a faster AI model writing the scene. The photos a model call failed on are
    // traced again by the button after this note instead (§32).
    const failed = thermal.photos.filter((p) => p.status !== 'ok');
    const onlyTime =
      failed.length > 0 &&
      failed.every((p) => p.status === 'model-failed' && /^(timed out|not traced)/.test(p.error ?? ''));
    if (canRegenerate && thermal.photos.length && !retraceSurfaces)
      sentences.push(
        onlyTime
          ? `${regenerate} with a faster AI model, to leave time to trace them.`
          : `${regenerate} to have the model trace them again.`,
      );
    return sentences.join(' ');
  }, [record.thermal, pictureWord, canRegenerate, regenerate, retraceSurfaces]);
  // A record from before measured temperatures existed, for pictures that carry them: worth a rebuild.
  const setHasThermalPhotos =
    source === 'orbit' || !experiment.photoThermal || experiment.photoThermal.some((t) => t !== false);
  const predatesMeasured = record.version < 6 && setHasThermalPhotos;
  // A record measured before its photos could be registered to the model: every surface is one median.
  // Worth a rebuild, but only a note — the measured view stands as it is.
  const predatesProjection = predatesProjectionOf(record.thermal);
  // What the Measured section says of the registration (§18.8): how many of the photos that reached the
  // model (registrationSummary) project their own pixels, or that none could. Nothing for a record from
  // before registration (its note says so) or without such a photo. The pixels land only where a photo
  // sees a surface squarely — at a steep slant the frame fades them into the face's value, at a graze it
  // keeps that value — so the sentence says so rather than promising every surface a photo sees.
  // Photos left out once the model was set down (§30.1) are not counted as registered: they project nothing.
  const projectable = Math.max(0, registration.registered - refusedPhotos.length);
  const registrationSentence =
    predatesProjection || registration.traced === 0
      ? null
      : projectable > 0
        ? `${projectable} of ${plural(registration.traced, pictureWord)} registered to the model — ${
            projectable === 1
              ? 'its own pixels are projected onto every surface it sees squarely'
              : 'their own pixels are projected onto every surface they see squarely'
          } (a surface seen at a steep slant fades into, or keeps, its face's one value); the rest is one value per face.`
        : `${
            registration.traced === 1
              ? `The ${pictureWord} could not be registered to the model`
              : `None of the ${plural(registration.traced, pictureWord)} could be registered to the model`
          }, so each surface is one value.`;
  // Surfaces the tracer outlined that the statistics could not read (§31.6) — said for the photos the frame
  // does not read back through the model: a projected photo's every face is read there, whatever was lost
  // of its tracing.
  const unreadNote = useMemo(() => {
    // Not while the thermal frames load: which photos are projected is not known yet (§31.7).
    if (projection.loading) return null;
    const projected = new Set(photosToSend.map((p) => p.photo));
    const why = (reason: string) =>
      reason === 'no-pixels'
        ? 'too narrow once its edges are trimmed off'
        : reason === 'too-few'
          ? 'too few pixels'
          : reason === 'excluded'
            ? 'mostly unreadable pixels'
            : reason;
    const lines: string[] = [];
    for (const p of record.thermal?.photos ?? []) {
      if (projected.has(p.photo) || !Array.isArray(p.unread) || !p.unread.length) continue;
      const counts = new Map<string, number>();
      for (const u of p.unread) {
        if (!u || typeof u.reason !== 'string') continue;
        counts.set(why(u.reason), (counts.get(why(u.reason)) ?? 0) + 1);
      }
      if (counts.size)
        lines.push(
          `${photoLabel(p.photo, pictureWord, photoPlaces)}: ${[...counts]
            .map(([w, n]) => `${plural(n, 'surface')} ${w}`)
            .join(', ')}`,
        );
    }
    return lines.length ? `Outlined but not read — ${lines.join('; ')}.` : null;
  }, [projection.loading, photosToSend, record.thermal, pictureWord, photoPlaces]);
  // Registered photos whose thermal frame did not load (or did not decode) are not projected.
  const unloaded = projection.loading
    ? 0
    : Math.max(0, Math.min(registration.registered, TWIN_PROJECTION_MAX) - projection.photos.length);
  // Photos taken half an hour apart were not taken under one set of conditions.
  const captureSpanMin = useMemo(() => {
    if (source !== 'photos' || !experiment.photoCapturedAt) return 0;
    const at = record.photosSent.map((k) => experiment.photoCapturedAt![k - 1] ?? 0).filter((ms) => ms > 0);
    if (at.length < 2) return 0;
    const span = Math.max(...at) - Math.min(...at);
    return span > CAPTURE_SPAN_NOTE_MS ? Math.round(span / 60_000) : 0;
  }, [source, experiment.photoCapturedAt, record.photosSent]);
  const statusLine = table
    ? [
        `${plural(table.stats.measured, 'surface')} measured in ${plural(table.stats.photos, pictureWord)}`,
        // The surfaces read back through the model from the registered photos' own pixels (§26).
        ...(sampled && sampled.length ? [`${plural(sampled.length, 'surface')} read through the model`] : []),
        `${plural(table.stats.inferred - table.stats.filled, 'face')} inferred`,
        // The faces only the all-inferred fill gave a value, and the faces left without one (which the
        // fill leaves none of, so a zero is not worth a term there).
        ...(table.stats.filled > 0
          ? [`${plural(table.stats.filled, 'face')} filled from the rest of the measurements`]
          : []),
        ...(table.stats.none > 0 ? [`${plural(table.stats.none, 'face')} without data`] : []),
        // The traced surfaces that did not reach the model as traced, by cause: naming a part the program
        // never built, facing away from the camera that traced them, landing on a face the scene did not
        // build — and the ones kept under the mirrored face the camera could see.
        ...(table.stats.rejectedNoPart > 0
          ? [`${plural(table.stats.rejectedNoPart, 'traced surface')} named a part the scene did not build`]
          : []),
        ...(table.stats.rejectedOrientation > 0
          ? [`${plural(table.stats.rejectedOrientation, 'traced surface')} faced away from the camera`]
          : []),
        ...(table.stats.flipped > 0
          ? [`${plural(table.stats.flipped, 'traced surface')} mirrored to the face the camera could see`]
          : []),
        ...(table.stats.unplaced > 0
          ? [`${plural(table.stats.unplaced, 'traced surface')} on a face the scene did not build`]
          : []),
      ].join(' · ')
    : null;
  const subjectLabel = record.subjectKind ? record.subjectKind : null;
  // What the program did wrong as it ran, which the revision thread offers to quote to the model — not a
  // measured table the viewer could not paint, which is no fault of the program's.
  const programProblem = frameError ?? (frameWarning && !frameWarning.startsWith(PAINT_FAILED) ? frameWarning : null);
  // A note to the AI (§19): the program and the same pictures go with it, the model writes the program again,
  // and the measured surfaces are traced again on what it wrote — or kept, when it wrote the same (§32).
  const reviseProgram = async (
    note: string,
    model: TwinModelKey,
    set: (progress: string) => void,
    signal: AbortSignal,
    extras?: { selection: TwinSelectionItem[]; images: TwinNoteImage[] },
    feed?: TwinFeed,
  ) => {
    const selection = extras?.selection ?? [];
    const images = extras?.images ?? [];
    // No sentence of its own (§28.4): the thread's pending turn spins, and shows what the Function streams
    // of the rewrite (§28.5), until the answer lands.
    set('');
    storeTwinRecord(
      experiment.id,
      await analyzeTwinBuilding(experiment.id, source, { note, model, selection, images }, signal, feed),
    );
  };
  // How a build or a revision ended is shown in About, on the Realistic view. One that failed or was
  // stopped while a thermal view was up is announced there instead, until the owner has been back to
  // Realistic and seen it.
  const [seenRun, setSeenRun] = useState<TwinRun | null>(null);
  const runEnded = !!run?.done;
  useEffect(() => {
    if (onRealistic && run && runEnded) setSeenRun(run);
  }, [onRealistic, run, runEnded]);
  const unseenEnd = !onRealistic && run && run.done && (run.error || run.stopped) && run !== seenRun ? run : null;
  // A build's progress, Stop and outcome appear under the toolbar at the foot of the column, which a long
  // column (a revision thread, a narrow stacked panel) pushes below the fold. When a build starts or ends
  // badly on the Realistic view, scroll the COLUMN — never the page — just far enough to show them. A
  // revision needs none of this: its bubble appears right above the box the note was typed in.
  const scrollRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const buildPhase =
    run && !run.revision ? (run.done ? (run.error ? 'failed' : run.stopped ? 'stopped' : 'done') : 'running') : null;
  useEffect(() => {
    if (!onRealistic || !buildPhase || buildPhase === 'done') return;
    const scroller = scrollRef.current;
    const actions = actionsRef.current;
    if (!scroller || !actions) return;
    const below = actions.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
    if (below > 0) scroller.scrollTop += below + 12;
  }, [onRealistic, run, buildPhase]);

  const clearPinsButton =
    pinned > 0 && probeActive ? (
      <Button type="link" size="small" onClick={clearPins}>
        Clear {plural(pinned, 'reading')}
      </Button>
    ) : null;

  return (
    <div className="twin-body">
      <div className="twin-side-top">
        {frameError && (
          <Alert
            type="error"
            showIcon
            message="The model's scene could not be built"
            description={`${frameError}${canRevise ? ` ${regenerate} to have the model write it again, or quote the error to it in a note under About.` : canRegenerate ? ` ${regenerate} to have the model write it again.` : ''}`}
          />
        )}
        {frameWarning && !frameError && (
          <div className="twin-note">
            {frameWarning}
            {canRevise && programProblem
              ? ` ${regenerate} to have the model write it again, or quote this to it in a note under About.`
              : canRegenerate
                ? ` ${regenerate} to have the model write it again.`
                : ''}
          </div>
        )}
        <section className="twin-section">
          <Segmented
            className="twin-view-mode"
            size="small"
            block
            value={mode}
            onChange={(v) => setChosenMode(v as ViewMode)}
            options={offered.map((m) => ({
              value: m,
              label: m === 'realistic' ? 'Realistic' : m === 'measured' ? 'Measured' : 'Simulated',
            }))}
          />
          {predatesMeasured && (
            <Alert
              type="info"
              showIcon
              message="Rebuild for measured temperatures"
              description={
                canRegenerate
                  ? `This twin was built before the camera's own temperatures were read onto the model. ${regenerate} to paint the surfaces the ${pictureWord}s measured.`
                  : `This twin was built before the camera's own temperatures were read onto the model; the owner can rebuild it.`
              }
            />
          )}
          {nothingPlaced && (
            <div className="twin-note">
              {namesDrifted
                ? `The model's part names did not match its scene, so none of the ${plural(thermalSurfaces, 'traced surface')} could be placed.`
                : `${thermalSurfaces === 1 ? 'The traced surface' : `None of the ${plural(thermalSurfaces, 'traced surface')}`} could be placed on the model: ${thermalSurfaces === 1 ? 'it faced' : 'they faced'} away from the camera, or fell on faces the scene did not build.`}
              {canRegenerate ? ` ${regenerate} to have the model write the scene again.` : ''}
            </div>
          )}
          {nothingPlaced && statusLine && <div className="twin-note-muted">{statusLine}</div>}
          {!onRealistic && liveRun && (
            <div className="twin-away">
              <LoadingOutlined spin />
              <span>
                {liveRun.revision
                  ? 'Revising the twin from your note'
                  : liveRun.retrace
                    ? `Tracing the ${pictureWord}s again`
                    : 'Regenerating the twin'}{' '}
                — switch to Realistic to follow it or stop it.
              </span>
            </div>
          )}
          {unseenEnd && (
            <div className={unseenEnd.error ? 'twin-away twin-away-failed' : 'twin-away twin-away-muted'}>
              <span>
                {unseenEnd.error
                  ? `${unseenEnd.revision ? 'Your note was not applied' : unseenEnd.retrace ? `The ${pictureWord}s were not traced again` : 'The regeneration did not finish'} — switch to Realistic to see why.`
                  : unseenEnd.revision
                    ? 'The revision was stopped — the model was left as it was.'
                    : unseenEnd.retrace
                      ? 'The tracing was stopped — the twin was left as it was.'
                      : 'The regeneration was stopped — the twin was left as it was.'}
              </span>
            </div>
          )}
        </section>
      </div>
      <div className="twin-main">
        <div className="twin-canvas">
          {frameDown ? (
            <div className="twin-frame-down" role="img" aria-label="The 3D viewer was stopped" />
          ) : (
            <iframe
              key={frameGen}
              ref={frameRef}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={TWIN_FRAME_HTML}
              title="digital twin"
              onLoad={onFrameLoad}
            />
          )}
          {frameFailed && !frameReady && !frameDown && (
            <div className="twin-frame-failed" role="alert">
              <span>{frameFailed}</span>
              <Button size="small" onClick={retryFrame}>
                Try again
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="twin-side-scroll" ref={scrollRef}>
        {/* Measured and Simulation each close the column in their own view (About is hidden there). */}
        {mode === 'measured' && table && measuredRange && (
          <section className="twin-section twin-section-last">
            <div className="twin-section-title">
              <span>Measured</span>
              {clearPinsButton}
            </div>
            <div className="twin-note-muted">
              What the camera read on each surface the {pictureWord}s show — apparent temperatures, no emissivity or
              reflection correction{registrationSentence ? `. ${registrationSentence}` : ', one value per surface.'}{' '}
              {FILL_HINT}
            </div>
            {statusLine && <div className="twin-note-muted">{statusLine}</div>}
            {/* "thermal data", not "thermal frames": a walk-around's pictures are frames already. */}
            {projection.loading && (
              <div className="twin-note-muted">Loading the thermal data of the {pictureWord}s…</div>
            )}
            {unloaded > 0 && (
              <div className="twin-note-muted">
                {unloaded === 1
                  ? `The thermal data of 1 ${pictureWord} could not be loaded, so it is not projected.`
                  : `The thermal data of ${unloaded} ${pictureWord}s could not be loaded, so they are not projected.`}
              </div>
            )}
            {registration.failures.length + refusedPhotos.length > 0 && (
              <div className="twin-note-muted">
                Not registered —{' '}
                {[
                  ...registration.failures,
                  ...refusedPhotos.map((r) => `${r.label}: once the model was set down, ${r.reason}`),
                ].join('; ')}
                .{retraceCameras && <> {retraceButton}</>}
              </div>
            )}
            {unreadNote && <div className="twin-note-muted">{unreadNote}</div>}
            {windowsNote && <div className="twin-note-muted">{windowsNote}</div>}
            {predatesProjection && (
              <div className="twin-note-muted">
                This twin was measured before its {pictureWord}s could be registered to the model, so each surface is
                one value
                {canRegenerate
                  ? `. ${regenerate} to project the ${pictureWord}s' own pixels.`
                  : '; the owner can rebuild it.'}
              </div>
            )}
            {captureSpanMin > 0 && (
              <div className="twin-note">
                The {pictureWord}s were captured over {captureSpanMin} min — conditions may have changed between them.
              </div>
            )}
            {matchable.length > 0 && (
              <div className="twin-fields">
                <Tooltip
                  title={`Paint the model in one ${pictureWord}'s own colours — its render's histogram equalisation over its own range, the sky's included, so the same temperature has the same colour on the model and in the ${pictureWord} — or stretch the palette evenly over the scale below`}
                >
                  <div className="twin-field twin-field-stack">
                    <span>Colours</span>
                    <Segmented
                      size="small"
                      block
                      value={colourSource}
                      onChange={(v) => setColours({ record, source: v as 'scale' | number })}
                      options={[
                        ...matchable.map((n) => ({
                          value: n,
                          label: `${pictureWord === 'frame' ? 'Frame' : 'Photo'} ${placeOf(n)}`,
                        })),
                        { value: 'scale', label: 'Scale' },
                      ]}
                    />
                  </div>
                </Tooltip>
              </div>
            )}
            <div className="twin-params">
              <ScaleField
                value={measuredRange}
                bounds={scaleBounds ?? table.sliderBounds}
                unit={unitKey}
                minWidth={MIN_SCALE_WIDTH}
                onChange={(r) => {
                  setMeasuredOverride({ record, range: r });
                  setColours({ record, source: 'scale' });
                }}
                tip={
                  matched
                    ? `The ${pictureWord}'s own range, painted as its render paints it; moving a handle switches to the palette stretched evenly over the scale.`
                    : "The colour scale is fixed: temperatures beyond its ends saturate at the palette's ends. It starts a degree beyond the coldest and warmest measured surface."
                }
              />
            </div>
          </section>
        )}
        {mode === 'simulated' && (
          <section className="twin-section twin-section-last">
            <div className="twin-section-title">
              <span>Simulation</span>
              {clearPinsButton}
            </div>
            <div className="twin-note-muted">
              What a thermal camera would read under the chosen conditions, from each part&apos;s kind and the way it
              faces, every part treated as a building&apos;s outside surface — a demonstration, not a measurement
              {measuredOffered ? ' (what the camera read is in the Measured view)' : ''}. A scenario fills in the
              conditions and the scale; every number here is yours to change.
            </div>
            <SimulationControls
              scenario={scenario}
              onScenario={changeScenario}
              range={simRange}
              onRange={setSimRange}
              presetKey={presetKey}
              onPreset={choosePreset}
              materials={materials}
              onMaterial={changeMaterial}
              onResetMaterials={() => setMaterials(defaultMaterials())}
              materialsOpen={materialsOpen}
              onMaterialsOpen={setMaterialsOpen}
              kinds={simKinds}
              unit={unitKey}
              minScaleWidth={MIN_SCALE_WIDTH}
            />
          </section>
        )}
        {/* Realistic view only, but hidden rather than unmounted on the thermal views, so a half-written
            note, a dismissed outcome and an open confirmation survive a switch of view. */}
        <section className="twin-section twin-section-last" hidden={!onRealistic}>
          <div className="twin-section-title">
            <span>About</span>
            {deleteAction}
          </div>
          <div className="twin-object">
            <div className="twin-object-head">
              <span className="twin-object-name">{record.name ?? 'Subject'}</span>
              <span className="twin-muted">
                {subjectLabel ? `${subjectLabel} · ` : ''}
                {built
                  ? `${plural(record.parts?.length ?? built.parts.length, 'part')} · ${plural(built.meshes, 'mesh')} · `
                  : ''}
                {Math.round((record.confidence ?? 0) * 100)}% confident
              </span>
            </div>
            {record.subject ? <div className="twin-object-desc">{record.subject}</div> : null}
            {record.description ? <div className="twin-object-desc">{record.description}</div> : null}
          </div>
          {thermalNote && (
            <div className="twin-note">
              {thermalNote}
              {retraceSurfaces && <> {retraceButton}</>}
            </div>
          )}
          {/* What the frame set down or found bare after the build (§29): the model on screen differs from
              the program by these moves, and the owner should know a roof is short before writing a note. */}
          {frameSettled && <div className="twin-note-muted">{frameSettled}</div>}
          {/* No provenance line (§28.4): which model wrote the program and traced the pictures is in the
              revision thread's meta lines and the build form, and the owner asked for the sentence to go. */}
          <TwinRequestNote instructions={record.instructions} ownerViewing={ownerViewing} />
          <TwinRevise
            experiment={experiment}
            revisions={record.revisions ?? []}
            kind="program"
            madeBy={twinModelOf(record, 'program')}
            canRevise={canRevise}
            problem={programProblem}
            reviseTitle={(model) =>
              `${model} rewrites the twin from your note and the pictures; the measured temperatures are read again if the model changes`
            }
            revise={reviseProgram}
            // What the note is about: whatever the owner clicked in the frame (§28).
            selection={selectedItems}
            pictures
            captureView={frameDown ? undefined : captureView}
          />
          {/* The host's build progress (Stop) and outcome close the section. Empty for a reader, and then
              hidden. */}
          <div className="twin-actions" ref={actionsRef}>
            {controls}
          </div>
        </section>
      </div>
    </div>
  );
};

export default TwinBuildingViewer;
