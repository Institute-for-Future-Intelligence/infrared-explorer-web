import type { GeoPoint, Timestamp } from 'firebase/firestore';

export interface User {
  displayName: string | null;
  email: string | null;
  avatar: string | null;
  id: string; // legacy Mongo ObjectId (the `mongoId` identity claim), NOT the Firebase auth.uid
}

/** Source/media discriminator for an experiment (decides which player renders it). */
export enum ExperimentType {
  Video = 'video', // videostore/<name>.{mp4,vir,wrk} -> VideoPlayer
  Recording = 'recording', // recordings/<recordingId>/data_N.* -> ImagePlayer
  // A PHOTO SET: several stills the capture app uploaded together as one experiment. Same Storage
  // layout as a recording (photo k is frame k under recordings/<recordingId>/), so every frame reader
  // serves it unchanged; the doc carries photoCount instead of a time axis and the ImagePlayer opens it
  // as a photo browser (a filmstrip, no playback). See docs/photo-set-experiments.md.
  Photos = 'photos',
}

/** Visibility of an experiment in the merged top-level `experiments` collection. */
export enum Visibility {
  Private = 'private',
  Unlisted = 'unlisted',
  Public = 'public',
}

export type Segment = { start: number; end: number };

export enum TemperatureUnit {
  celsius = 'celsius',
  fahrenheit = 'fahrenheit',
}

export enum ExperimentSubjects {
  NA = 'not available',
  Chemistry = 'chemistry',
  Physics = 'physics',
  Biology = 'biology',
}

/**
 * Per-experiment chart display preferences, persisted on the experiment doc (like graphsOptions) so every
 * viewer sees the same chart appearance the owner configured. Hydrated into the store's chart-settings
 * slices when the experiment opens; the owner's edits auto-save. Canonical shape — the store imports these.
 */
export interface LineChartSettings {
  lineWidth: number;
  symbolCount: number;
  symbolSize: number;
  horizontalGrid: boolean;
  verticalGrid: boolean;
  frameStats: boolean; // overlay the whole-frame min/max/mean envelope (dashed) on T(t)
}
export interface ScatterChartSettings {
  lineWidth: number;
  errorBars: boolean;
  horizontalGrid: boolean;
  verticalGrid: boolean;
}
export interface ProfileChartSettings {
  lineWidth: number;
  horizontalGrid: boolean;
  verticalGrid: boolean;
}
export interface HistogramChartSettings {
  bins: number; // number of equal-width temperature buckets the frame's pixels are binned into
  horizontalGrid: boolean;
  verticalGrid: boolean;
}
export interface IsothermSettings {
  // Locked contour temperatures in Celsius, drawn on every frame regardless of that frame's own range —
  // so a fixed-temperature front can be watched as it propagates. `null` (or the whole field absent) means
  // AUTO: levels are re-derived per frame, evenly between that frame's min and max (the default behaviour).
  lockedLevels: number[] | null;
  // How the contour temperatures are shown while isotherms are on: 'legend' (the corner legend box, the
  // default) or 'line' (no legend — each temperature printed directly on its contour). The toolbar button
  // cycles off → legend → line → off; absent means 'legend'.
  labelMode?: 'legend' | 'line';
}
export interface ChartSettings {
  line: LineChartSettings;
  scatter: ScatterChartSettings;
  profile?: ProfileChartSettings; // T(l) line-profile prefs; optional so legacy docs stay valid
  histogram?: HistogramChartSettings; // N(T) distribution prefs; optional so legacy docs stay valid
  isotherm?: IsothermSettings; // locked/auto contour levels; optional so legacy docs stay valid
}

/**
 * A line-profile transect drawn on the image: endpoints A (x1,y1) and B (x2,y2) in fractional
 * [0,1] image coordinates (the same space thermometers/annotations use). The T(l) chart samples
 * temperature along A→B for the current frame. An experiment can hold several (see
 * Experiment.profileLines); `id` keys each one for drag/delete and pairs its overlay with its chart series.
 */
export interface ProfileLine {
  id: string;
  // Optional user-given name shown at the line's midpoint and as its chart-series label. Empty/absent
  // falls back to the positional default "L1", "L2", … (its index in profileLines).
  name?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // Optional real-world length of the transect in centimetres, set by the user to calibrate the T(l)
  // gradient tool (dT/dx): with it the fitted slope reads in °/cm (a physical gradient, e.g. for Fourier's
  // law); without it the tool falls back to °/pixel. Absent/undefined = uncalibrated. Serialized as null
  // (never undefined) for Firestore, like `name`.
  lengthCm?: number;
}

/**
 * Result of cross-checking a generated report's figures against the measured data: how many temperatures,
 * times and rates it cited, how many of those were found in the numbers (or are a difference of two that
 * were), and the snippets that were not. A trust signal, not a proof — it can only say that a value does
 * not appear in the data, which is exactly the failure worth surfacing.
 */
/** Frame budget behind a generated report: how many samples were asked for, how many decoded, how many
 *  were dropped as truncated, and how many intervals were re-read densely because things moved fast. */
export interface ReportSampling {
  requested: number;
  used: number;
  truncated: number;
  densifiedWindows: number;
}

export interface ReportVerification {
  checked: number;
  matched: number;
  unmatched: string[];
}

// ---------------------------------------------------------------------------------------------------
// 3D digital twin (docs/digital-twin-plan.md). These MIRROR the server contract in
// functions/src/twinScene.ts (TwinScene / TwinObject / the kind and enum lists) — the client never
// imports from functions/, so keep the two in step by hand when the contract version bumps.

export type TwinObjectKind =
  | 'beaker'
  | 'erlenmeyer_flask'
  | 'test_tube'
  | 'test_tube_rack'
  | 'graduated_cylinder'
  | 'bottle'
  | 'cup'
  | 'kettle'
  | 'pot'
  | 'petri_dish'
  | 'alcohol_lamp'
  | 'bunsen_burner'
  | 'candle'
  | 'hot_plate'
  | 'tripod'
  | 'wire_gauze'
  | 'ring_stand'
  | 'clamp'
  | 'thermometer'
  | 'metal_block'
  | 'ice'
  | 'hand'
  | 'person'
  | 'phone'
  | 'laptop'
  | 'screen'
  | 'other';

export interface TwinBBox {
  x: number; // left edge, fraction of the frame width
  y: number; // top edge, fraction of the frame height
  w: number;
  h: number;
}

export interface TwinObject {
  id: string;
  kind: TwinObjectKind;
  label: string;
  confidence: number; // 0..1
  bbox: TwinBBox;
  footprintY: number; // fraction of the frame height where the object meets what it rests on
  sizeCm: { height: number; width: number }; // the model's estimate; the solver prefers nominal sizes
  material: 'glass' | 'metal' | 'plastic' | 'ceramic' | 'wood' | 'paper' | 'liquid' | 'organic' | 'other';
  fill: { level: number; content: string }; // liquid fill fraction (0 for solids / empty)
  restingOn: string; // another object's id, 'support', or 'held' (in the air: a hand, a pour)
  // Contract v2 (absent on records analysed before): lean from upright as seen in the image, −90..90,
  // positive = the top leans toward the image's right; and, for a held object, the id of what it is
  // held over / pouring into ('' if none). The solver treats an absence as upright and over nothing.
  tiltDeg?: number;
  heldOver?: string;
  thermal: { role: 'heat_source' | 'heated' | 'cooled' | 'ambient'; note: string };
}

export interface TwinScene {
  renderable: boolean;
  reason: string;
  confidence: number;
  camera: { pitch: 'level' | 'slightly_above' | 'high_angle' | 'top_down'; distanceHint: 'close' | 'medium' | 'far' };
  support: { kind: 'table' | 'bench' | 'floor' | 'unknown'; farEdgeY: number };
  objects: TwinObject[];
}

/** Result of the client-side camera-motion gate (utils/twinStability.ts), recorded with the analysis. */
export interface TwinStability {
  stable: boolean;
  maxShiftPx: number; // largest frame-to-frame shift found, thermal px
  p95ShiftPx: number;
  sampled: number; // how many frames were compared
  referenceIndex: number; // the recording frame judged stillest — the one that was analysed
}

/** What the analyzeTwinScene Function persists on the experiment doc. */
export interface TwinSceneRecord {
  version: number; // contract version (TWIN_SCENE_VERSION server-side)
  model: string; // concrete model id that produced the scene
  analyzedAt?: Timestamp; // server-set
  recordingIndex: number; // the frame analysed (recording-frame space, 1-based)
  stability: TwinStability | null;
  scene: TwinScene;
  blocker: string | null; // the deterministic "do not render" reason, if any, at analysis time
  // Visible→thermal offset measured on the analysed frame, thermal px (a visible feature at (u, v) sits
  // at (u + dx, v + dy) in the thermal frame); null when nothing correlated well enough to trust.
  registration: { dx: number; dy: number; score?: number; method?: string } | null;
}

/** An owner's correction to one recognised object (keyed by the object's id in the scene). Every field
 *  is optional: only what was changed is stored, and an absent map means "as the model said". */
export interface TwinObjectEdit {
  kind?: TwinObjectKind;
  spec?: string; // a NOMINAL_SIZES label for the kind (e.g. "250 mL"); absent = solver's choice
  hidden?: boolean; // leave it out of the twin (a misdetection, or clutter)
  restingOn?: string;
}

/** Owner corrections to the twin, written client-side (NOT Function-written, unlike twinScene): the
 *  scene analysis stays as the model gave it and these are applied on top when the twin is solved. Cleared
 *  by a regeneration, since they are keyed by the previous scene's object ids. */
export interface TwinEdits {
  pitchDeg?: number | null; // camera tilt override; null/absent = the model's category
  objects?: Record<string, TwinObjectEdit>;
}

// ---- The building twin of a PHOTO SET (docs/digital-twin-plan.md §17). Mirrors the server contract in
// functions/src/twinBuilding.ts — keep in step by hand.

/** Where a photo's camera stood in the scene frame, as the model judged it: the viewer looks from there. */
export interface TwinBuildingView {
  photo: number;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

/** What the analyzeTwinBuilding Function persists on a photo set's experiment doc — in the same
 *  `twinScene` field as a recording's TwinSceneRecord (so the same rules protect it), told apart by
 *  `kind`. The building is a small three.js program (contract v5) the sandboxed viewer runs; records
 *  from the earlier block-based contract (version < 5) carry a `scene` instead and are shown as stale. */
export interface TwinBuildingRecord {
  kind: 'building';
  version: number; // TWIN_BUILDING_VERSION server-side
  model: string;
  analyzedAt?: Timestamp; // server-set
  photosSent: number[]; // the photo numbers the model saw
  renderable?: boolean;
  reason?: string;
  confidence?: number; // 0..1
  name?: string;
  description?: string;
  code?: string; // the body of function (THREE, scene, api); absent on version < 5
  views?: TwinBuildingView[];
  blocker: string | null;
}

export type TwinRecord = TwinSceneRecord | TwinBuildingRecord;

export const isTwinBuildingRecord = (r: TwinRecord | null | undefined): r is TwinBuildingRecord =>
  !!r && (r as TwinBuildingRecord).kind === 'building';

// Re-exported so the experiment shapes below can name it without every consumer reaching into utils.
export type { ReportInputsDescriptor } from './utils/reportFreshness';

/**
 * Persistent Firestore shape at `experiments/{expId}` (the merged showcase + user-clip
 * collection). Aggregates (ratingSum/ratingCount/viewCount) are maintained by Functions
 * and are read-only from the client. See docs/telelab-migration.md §4.
 */
export interface ExperimentDoc {
  sourceType: ExperimentType;
  ownerId: string; // mongoId, or 'system' for showcases
  visibility: Visibility;
  // Staff-curated homepage flag. Staff (@intofuture.org) may set it on their OWN experiments from the
  // UI, or it's set in bulk via the Admin SDK (scripts/feature.mjs); rules enforce staff+owner and the
  // featured⇒public invariant, and freeze it against non-staff owner edits. Decoupled from
  // `visibility`: public = shown on the owner's profile page; featured = shown on the site homepage.
  featured?: boolean;

  displayName: string;
  author: string;
  description: string;
  subject: ExperimentSubjects | null;
  duration: number;
  date: string;
  thumbnailURL: string;

  graphsOptions?: ExperimentGraphOption[];
  // Per-experiment chart display prefs (line width / symbols / grids / error bars / frame overlay),
  // owner-authored so all viewers see the same chart appearance. See ChartSettings.
  chartSettings?: ChartSettings;
  // The line-profile transects for the T(l) chart (fractional [0,1] endpoints). Absent/empty until the
  // owner adds one; carried forward on clone like the other spatial analysis fields. See ProfileLine.
  profileLines?: ProfileLine[];
  thermalUnit: TemperatureUnit;

  // The FLIR palette the baked false-colour frames (data_N.png / mp4) were rendered with — a
  // PALETTE_COLORS key (lowercase: 'iron' | 'rainbow' | 'rainhc' | …). Lets the scale-bar overlay draw the
  // exact colour↔temperature ramp. `paletteSource` records how we know it: 'app' = frozen at record time
  // by the capture app and written on upload (authoritative), 'detected' = inferred client-side from the
  // rendered pixels. There is no human picker — a palette is a fact of the recording, not a preference.
  // ('manual' may survive on a few docs from the removed owner/staff tagger; still honoured on read.)
  // Absent on legacy docs → the bar falls back to an approximate ramp.
  palette?: string;
  paletteSource?: 'app' | 'detected' | 'manual';

  // The phone's attitude when the recording started, written by the capture app from its fused
  // orientation sensor (app-captured recordings only; absent before the app recorded it). Sensor
  // convention: pitchDeg = camera elevation above the horizon (+ = tilted UP), rollDeg = rotation about
  // the optical axis, azimuthDeg = heading 0..360 clockwise from magnetic north. The 3D twin's solver
  // reads the tilt from here instead of guessing it from the photo (docs/digital-twin-plan.md §6.2).
  capturePose?: { pitchDeg: number; rollDeg: number; azimuthDeg: number };

  createdAt?: Timestamp; // server-set on create/clone; absent on some legacy docs
  updatedAt?: Timestamp; // server-set on every edit (rename/describe/retag/trash/…); absent until first edit
  trash: boolean;
  // Staff takedown (governance): set when a staff member removes the experiment from the whole site.
  // While set, the owner can't restore it (rules) — only a staff Restore clears it. Audit trail rides
  // along. See services/curation.ts.
  trashedByStaff?: boolean;
  takedownReason?: string;
  takedownAt?: Timestamp;
  takedownBy?: string;
  isRaw: boolean; // untrimmed source clip (mirrors segments == null for indexable queries)
  segments: Segment[] | null;

  name?: string; // video-only: videostore slug
  recordingId?: string; // recording + photo set: the recordings/<id>/ Storage prefix
  // Photo set only (sourceType 'photos'). photoCount is the number of frames under the prefix
  // (data_1..data_photoCount); `duration` is written as 0 and never read for a set. The arrays are
  // aligned with the photos (index k-1 ↔ frame k): the capture instant of each (epoch ms, 0 =
  // unknown), an optional caption per photo (absent when none has one), and — when the photos were
  // not all baked with the same palette — each photo's palette key (null = unknown); a uniform set
  // writes the ordinary `palette` instead. Written by the capture app (experimentDoc.ts there).
  photoCount?: number;
  photoCapturedAt?: number[];
  photoTitles?: string[];
  photoPalettes?: (string | null)[];
  // Whether photo k carries temperature data (data_k.dat + renders) or is a picture only (data_k.png
  // holds the photo itself — possibly JPEG bytes — and nothing else). Absent = every photo has data
  // (sets uploaded before the flag existed). The browser switches its thermal tools off on a
  // picture-only photo instead of fetching a .dat that is not there.
  photoThermal?: boolean[];
  // Set to the source experiment's id when this doc was made by cloning (Save to My Experiments /
  // Save clip / classroom copy). Absent on a genuine original recording. Lets "Raw Data" show only
  // original captures, since isRaw alone can't tell an original recording from an untrimmed copy.
  clonedFrom?: string;
  // video-only: set on a clone that was saved with edited thermometers. They then live in the
  // thermometers subcollection and are loaded from there, instead of re-derived from the .wrk preset.
  customThermometers?: boolean;

  // AI lab report (Markdown), written by the generateLabReport Cloud Function (owner only).
  aiReport?: string;
  aiReportAt?: Timestamp;
  aiReportModel?: QaModel; // which model produced the saved report (for the UI badge)
  // The owner's optional notes for that generation (focus/length requests, or setup context the numbers
  // can't show). Kept with the report so a steered report is never displayed as an unguided one.
  aiReportInstructions?: string | null;
  // Fingerprint of the thermal inputs the saved report was written from (trim, probe geometry,
  // transects). When the experiment's current fingerprint differs, the report describes data that has
  // since changed — the report tab says so instead of presenting it as current.
  aiReportInputsHash?: string;
  // How the report's figures fared against the measured data: how many were checked, how many were found
  // in it, and the snippets that were not. Null/absent means the check did not run — shown as
  // "not cross-checked", never as a pass.
  aiReportVerified?: ReportVerification | null;
  // Description of the thermal inputs the saved report was written from, stamped by the Function. The
  // report tab rebuilds the same description from the experiment as it stands and flags a mismatch —
  // see src/utils/reportFreshness.ts.
  aiReportInputs?: ReportInputsDescriptor | null;
  // Whether the model was actually shown the sampled frames. False for a text-only model, a video (no
  // per-frame renders exist) and any recording whose renders could not be loaded.
  aiReportVision?: boolean;
  // How many frames the saved report rests on, and how many windows were sampled more densely because
  // the measurements were moving fast there.
  aiReportSampling?: ReportSampling | null;

  // Owner-marked chapters (index + time + label only; no image — see KeyMoment). Owner-written client-side.
  keyMoments?: StoredKeyMoment[];

  // The 3D digital twin's scene analysis — a recording's TwinSceneRecord (analyzeTwinScene) or a photo
  // set's TwinBuildingRecord (analyzeTwinBuilding), told apart by `kind` — written ONLY by those
  // Functions (barred from
  // client writes like the aiReport* fields — it is shown to every viewer as machine-derived). See
  // TwinSceneRecord and docs/digital-twin-plan.md.
  twinScene?: TwinRecord;
  // The owner's corrections to that scene (client-written; see TwinEdits).
  twinEdits?: TwinEdits;

  // Function-maintained aggregates (client read-only).
  ratingSum: number;
  ratingCount: number;
  viewCount: number;
  commentCount: number;
}

// ── Street View (geo-tagged thermal panoramas) ──────────────────────────────
// Read-only on the web: the map browses public `streetviews` docs and a viewer
// opens one. Capture/upload stays in the mobile app. See docs/street-view-web-plan.md.

/** A neighbouring street view the panorama can jump to (legacy `neighbors`). */
export interface StreetViewNeighbor {
  azimuthDeg: number; // bearing TO the neighbour, degrees
  svId: string; // the neighbour's `streetviews` document id
}

/** One shot of an app-uploaded street view (the app's buildStreetViewDoc shape). */
export interface StreetViewShot {
  index: number;
  azimuthDeg: number;
  pitchDeg: number;
}

/**
 * Persistent Firestore shape at `streetviews/{svId}` — a geo-tagged thermal panorama.
 * Two producers write it: (A) the legacy seed (scripts/seedStreetViews.mjs, ownerId
 * 'system', legacy:true, top-level azimuthDeg[]/pitchDeg[]/neighbors + virUrl; later
 * stamped streamUrl/videoDurationSec by streamAll.mjs's all-intra re-encode), and (B)
 * the mobile app (per-shot shots[] + data_N.* frames under streetviews/{svId}/).
 * Aggregates are 0 on create and maintained server-side. toStreetView() flattens both.
 */
export interface StreetViewDoc {
  sourceType: 'single' | 'pano';
  ownerId: string; // mongoId, or 'system' for the legacy seed
  visibility: Visibility;
  location: GeoPoint;
  geohash: string; // geofire precision-9; for future viewport queries
  displayName: string;
  author: string;
  description?: string;
  thermalUnit?: string;
  palette?: string; // FLIR palette key the baked frames were rendered with ('inferno' on the seed)

  // (A) legacy: per-frame orientation as top-level arrays + neighbour graph + source clip
  azimuthDeg?: number[];
  pitchDeg?: number[];
  frameCount?: number;
  neighbors?: StreetViewNeighbor[];
  virUrl?: string;
  // stamped by streamAll.mjs: a browser-seekable all-intra mp4 + its CONTENT duration
  // (pre-tail-pad) that frame→seek-time maps against. Absent until the re-encode runs.
  streamUrl?: string;
  videoDurationSec?: number;
  // stamped by stitchAll.mjs: a wide equirectangular panorama baked from the per-frame
  // azimuth (0°=North at x=0, full 360°), for the drag-to-pan wide-FOV viewer. Absent
  // until the stitch runs; the viewer then prefers it over the frame-seek video.
  panoUrl?: string;
  panoSpanDeg?: number; // angular width the pano covers (360 for a full sweep)
  // Temperature panorama (stitchAll.mjs, aligned to panoUrl): a lossless PNG with
  // centi-kelvin in the R/G bytes (°C = (R*256+G)/100 − 273.15), A=0 for gaps. Powers
  // the viewer's probe / scale / histogram / isotherm tools. tMin/tMax are °C.
  panoTempUrl?: string;
  panoTempW?: number;
  panoTempH?: number;
  tMin?: number;
  tMax?: number;

  // (B) app-native: per-shot orientation (frames are data_N.dat/.png in Storage)
  shots?: StreetViewShot[];

  legacy?: boolean;
  date?: Timestamp;
  createdAt?: Timestamp;
  trash: boolean;
  ratingSum: number;
  ratingCount: number;
  viewCount: number;
  commentCount: number;
}

/**
 * Normalised street view the web map + viewer consume — the two producer shapes
 * flattened by toStreetView() (utils/streetView.ts). Mirrors the app's StreetViewMarker
 * (lib/streetViewBrowse.ts). `azimuthDeg`/`pitchDeg`/`neighbors` are empty until the full
 * doc is hydrated on marker click; the map only needs lat/lng/title.
 */
export interface StreetView {
  svId: string;
  // Governance fields, needed wherever a panorama can be acted on: ownerId is what a block
  // list and a suspension are keyed by ('system' for the seeded map, which is ours, not UGC),
  // and trash/hiddenByReports are how the staff tools tell "the owner put it away" apart from
  // "a report took it down". The map query never returns a hidden doc; the ?sv= deep link and
  // the admin queue do.
  ownerId: string;
  visibility: Visibility;
  trash: boolean;
  hiddenByReports: boolean;
  lat: number;
  lng: number;
  title: string;
  author: string;
  sourceType: 'single' | 'pano';
  frameCount: number;
  palette?: string;
  thermalUnit?: string;
  azimuthDeg: number[];
  pitchDeg: number[];
  neighbors: StreetViewNeighbor[];
  capturedAt?: number; // epoch ms, from the doc's createdAt (shown in the readout)
  virUrl?: string;
  streamUrl?: string;
  videoDurationSec?: number;
  panoUrl?: string; // wide 360° panorama (stitchAll.mjs); preferred by the viewer
  panoSpanDeg?: number;
  panoTempUrl?: string; // aligned temperature panorama (PNG-RG centi-kelvin) for the thermal tools
  panoTempW?: number;
  panoTempH?: number;
  tMin?: number; // global °C range of the temp pano (for the scale bar)
  tMax?: number;
}

/**
 * Hydrated client-side experiment: the persisted doc plus view fields assembled at fetch
 * time (thermometer/comment ids, playback position). New doc fields are optional here so
 * the legacy showcase/JSON construction paths keep compiling until the Phase 1 path
 * migration populates them.
 */
export interface Experiment {
  recordingId?: string;
  segments: { start: number; end: number }[];

  name: string; // file slug (the old MP4-based experiment needs this)
  displayName: string; // the title
  author: string;
  description: string;
  viewCount?: number;
  disallowCopy?: boolean;
  subject: ExperimentSubjects | null;
  duration: number;
  currentPercent?: number; // last viewed frame of a recorded MP4 experiment (in percentage)
  currentFrameNumber?: number;
  currentFrameNumberInJoinedSegments?: number;
  date: string;
  thumbnailURL: string;

  readonly id: string;

  graphsOptions?: ExperimentGraphOption[];
  chartSettings?: ChartSettings; // per-experiment chart display prefs; see ExperimentDoc.chartSettings
  profileLines?: ProfileLine[]; // T(l) transects (fractional endpoints); see ExperimentDoc.profileLines
  thermometersId: string[];
  commentsId?: string[];
  timeStamp?: string;

  // Merged-collection fields (optional during migration; populated from ExperimentDoc).
  sourceType?: ExperimentType;
  ownerId?: string;
  visibility?: Visibility;
  featured?: boolean; // shown on the site homepage; staff-settable on their own experiments (see ExperimentDoc.featured)
  customThermometers?: boolean; // video-only: thermometers persisted in the subcollection (see ExperimentDoc)
  thermalUnit?: TemperatureUnit;
  palette?: string; // FLIR palette key of the baked frames; see ExperimentDoc.palette
  paletteSource?: 'app' | 'detected' | 'manual';
  capturePose?: { pitchDeg: number; rollDeg: number; azimuthDeg: number }; // phone attitude at record start; see ExperimentDoc.capturePose
  photoCount?: number; // photo set: number of photos (frames); see ExperimentDoc.photoCount
  photoCapturedAt?: number[]; // photo set: capture instant per photo; see ExperimentDoc.photoCapturedAt
  photoTitles?: string[]; // photo set: caption per photo; see ExperimentDoc.photoTitles
  photoPalettes?: (string | null)[]; // photo set: palette per photo when not uniform; see ExperimentDoc.photoPalettes
  photoThermal?: boolean[]; // photo set: which photos carry temperature data; see ExperimentDoc.photoThermal
  trash?: boolean;
  isRaw?: boolean;
  clonedFrom?: string; // id of the source experiment this was cloned from; see ExperimentDoc.clonedFrom
  ratingSum?: number;
  ratingCount?: number;
  commentCount?: number;
  aiReport?: string; // AI-generated lab report (Markdown); see ExperimentDoc.aiReport
  aiReportModel?: QaModel; // model that produced aiReport; see ExperimentDoc.aiReportModel
  aiReportInstructions?: string | null; // owner's notes for that run; see ExperimentDoc.aiReportInstructions
  aiReportInputsHash?: string; // inputs the report was written from; see ExperimentDoc.aiReportInputsHash
  aiReportVerified?: ReportVerification | null; // figure cross-check; see ExperimentDoc.aiReportVerified
  aiReportInputs?: ReportInputsDescriptor | null; // inputs the report used; see ExperimentDoc.aiReportInputs
  aiReportVision?: boolean; // was the model shown the frames; see ExperimentDoc.aiReportVision
  aiReportSampling?: ReportSampling | null; // frames behind the report; see ExperimentDoc.aiReportSampling
  aiReportAt?: Timestamp; // when the saved report was generated; see ExperimentDoc.aiReportAt
  keyMoments?: StoredKeyMoment[]; // owner-marked chapters; see ExperimentDoc.keyMoments
  twinScene?: TwinRecord; // 3D twin analysis (a recording's scene or a photo set's building); see ExperimentDoc.twinScene
  twinEdits?: TwinEdits; // owner corrections to it; see ExperimentDoc.twinEdits
  createdAt?: Timestamp; // rides along from ExperimentDoc; see its definition
  updatedAt?: Timestamp; // rides along from ExperimentDoc; server-set on every edit
}

export enum MeasuringAreaType {
  Point = 'point',
  Rectangle = 'rectangle',
  Ellipse = 'ellipse',
}

export interface Thermometer {
  id: string;
  // Optional user-given name shown on the image overlay and as the line-chart series label.
  // Empty/absent falls back to the positional default "T1", "T2", … (its index in thermometersId).
  name?: string;
  x: number;
  y: number;
  value: number;
  unit: TemperatureUnit;
  // Optional measuring area: the reading becomes the average over the area (default: a point).
  measuringAreaType?: MeasuringAreaType;
  measuringAreaWidth?: number; // fractional [0,1]
  measuringAreaHeight?: number; // fractional [0,1]
  // True when the Lab Assistant placed this probe (its add_thermometer tool). Displayed distinctly, so a
  // machine-chosen position is never mistaken for a decision the student made — the placement IS part of
  // the experiment, and its provenance should be as visible as the reading.
  aiPlaced?: boolean;
}

export interface Annotation {
  id: string;
  x: number; // [0,1] fractional position of the anchor (subject) on the image
  y: number; // [0,1]
  dx?: number; // [-1,1] note offset from the anchor (fraction of width); default 0
  dy?: number; // [-1,1] note offset from the anchor (fraction of height); default 0
  note: string;
  // Optional playback window in seconds; absent = always visible (telelab parity).
  time?: { start: number; end: number };
}

// Selectable model for the free-form AI Q&A. Every option is a third-party model reached through its
// vendor's OpenAI-compatible API (OpenAI / Google Gemini / xAI Grok / DeepSeek). The key maps to a
// concrete provider + model id server-side (see QA_MODELS in functions/src/index.ts).
export type QaModel = 'gpt56' | 'gpt52' | 'gemini' | 'grok' | 'deepseekPro' | 'deepseekFlash';

// Selectable model for the site-wide Lab Assistant agent — same set as the Q&A (all OpenAI-compatible,
// all support the tool loop). Maps to concrete ids server-side (AGENT_MODELS in functions/src/index.ts).
export type AgentModel = 'gpt56' | 'gpt52' | 'gemini' | 'grok' | 'deepseekPro' | 'deepseekFlash';

// The Q&A / Agent model keys share the same set today. Single source of truth for the pickers and for the
// runtime guards that validate a persisted / stored value (localStorage, Firestore). Display order matches
// the product's model list.
export const MODEL_KEYS: readonly QaModel[] = ['gpt56', 'gpt52', 'gemini', 'grok', 'deepseekPro', 'deepseekFlash'];
export const isModelKey = (v: unknown): v is QaModel => typeof v === 'string' && (MODEL_KEYS as string[]).includes(v);

// Default model, used everywhere a saved/absent Q&A/report value must fall back to a valid current key
// (localStorage, Firestore, server). The first list item (a fast, vision-capable chat model).
export const DEFAULT_MODEL: QaModel = 'gpt56';

// Default model for the site-wide Lab Assistant specifically (localStorage, server) — deliberately
// separate from DEFAULT_MODEL so the two pickers can default differently.
export const DEFAULT_AGENT_MODEL: AgentModel = 'gpt56';

// Human labels for every selectable model, shared by all model pickers (Q&A, report, Lab Assistant) so
// the lists never drift. Keyed by the model key.
export const MODEL_LABELS: Record<QaModel, string> = {
  gpt56: 'OpenAI GPT-5.6 Luna',
  gpt52: 'OpenAI GPT-5.2',
  gemini: 'Gemini 2.5 Pro',
  grok: 'Grok 4.5',
  deepseekPro: 'DeepSeek V4-Pro',
  deepseekFlash: 'DeepSeek V4-Flash',
};

// Models that can't see the attached false-colour frames (no vision). Moments can still be attached while
// one is selected — the server sends that frame's probe readings + whole-frame stats as numbers and skips
// the images — so this only drives the "numbers, not the picture" wording in the Q&A panel. Must mirror the
// server's `vision` flag (resolveOpenAiProvider): the GPT / Gemini / Grok models are multimodal; the
// DeepSeek models are text-only.
export const isTextOnlyModel = (m: QaModel): boolean => m === 'deepseekPro' || m === 'deepseekFlash';

/**
 * One "moment" a user attaches to a free-form AI question (Analysis-tab Q&A). A frozen snapshot of the
 * player's current frame: recordingIndex (recording-frame space, durable across re-trim) + its playback
 * time, a thumbnail (the on-screen frame data URL, for the chip), and the probe readings at that frame
 * (display only — the server recomputes authoritative values from recordingIndex). Capped at 3.
 */
export interface QaMoment {
  recordingIndex: number;
  tSeconds: number;
  thumbnail: string;
  readings: { label: string; value: number }[];
  /**
   * Ask-AI moments only: the PLAYER AS DISPLAYED at that instant, captured to a data URL — the frame
   * with the probe markers, annotation callouts and transect lines drawn on it. Sent with the question
   * so a vision model sees what the student sees, in place of the bare stored render of the same view
   * (`overlayView` says which view it is a capture of, so the server drops the right one and still
   * sends the other). Absent on a key moment, and whenever the capture failed — the server then falls
   * back to the stored renders. Never persisted: it is a session-sized data URL, not a stored field.
   */
  overlay?: string;
  overlayView?: ViewMode;
}

/**
 * A "key moment" the owner marks on the timeline for viewers to jump to — a single frame, or a time span
 * (a range with an end). Built from the player snapshot as a QaMoment (so the START frame carries a
 * thumbnail + readings in memory) plus an optional end and caption. `endRecordingIndex`/`endTSeconds`
 * are set only for a span; clicking a span plays start→end and pauses. Persisted (see keyMoments on
 * ExperimentDoc) as only { recordingIndex, tSeconds, end…, text } — the thumbnail is a full-frame data
 * URL and never goes to Firestore; a hydrated moment renders from its stored fields (image lazily
 * rebuilt for recordings).
 */
export interface KeyMoment extends QaMoment {
  endRecordingIndex?: number; // present iff this is a span (recording-frame space, like recordingIndex)
  endTSeconds?: number; // player time of the span end
  text?: string; // the author's caption for this moment
}

/** A key moment as stored on the experiment doc — indices + times + caption only, no image. */
export interface StoredKeyMoment {
  recordingIndex: number;
  tSeconds: number;
  endRecordingIndex?: number;
  endTSeconds?: number;
  text?: string;
}

// Toolbar pages cycled through with the up/down arrows (telelab ControlBarState parity).
export type ToolPage = 'analyze' | 'clip';

// Which per-frame render the image player shows. 'ir' is the classic palette render
// (every recording has it); app-captured recordings additionally upload a visible-light
// still and the true MSX blend. Temperatures always come from the .dat regardless.
export type ViewMode = 'ir' | 'visible' | 'blended';

export enum ExperimentGraphOption {
  noGraph = 0,
  time = 1,
  spaceX = 2,
  spaceY = 3,
  // T(l): temperature sampled along a user-drawn line on the image (a "line profile" / transect). The
  // value 4 was reserved long ago as `spaceR` (a never-implemented radial plot); it now backs the line
  // profile — no stored doc ever carried 4, so the rename is safe.
  lineProfile = 4,
  isotherm = 5,
  // (6 was a standalone whole-frame min/max/mean chart; it now overlays the T(t) plot via that plot's
  //  menu toggle — a lineChartSettings display option — so it's no longer a graphsOptions value.)
  // Two on-image overlays for the current frame, each its own player-toolbar toggle (like `isotherm`).
  // `scaleBar` is the temperature colour-scale bar; `hotspots` marks the hottest & coldest pixels. Both
  // are accurate because the capture app auto-gains each frame: this frame's min→max spans the baked
  // palette, so the bar's endpoints and the markers' labels match the on-screen colours.
  scaleBar = 7,
  hotspots = 8,
  // N(T): the current frame's temperature distribution — a histogram of all 120×160 pixels binned over a
  // clip-fixed temperature range. Like the scatters it's a whole-frame chart (needs no drawn geometry), so
  // it's a Charts-panel chip; value 9 is the next free slot (6 was retired, 7/8 are on-image overlays).
  histogram = 9,
  // Δ frame-difference imaging: a diverging blue→white→red overlay of (current frame − reference frame)
  // per-pixel temperature, isolating what heated/cooled relative to a chosen frame (default t=0). An
  // on-image overlay like scaleBar/hotspots (value 10), not a grid chart.
  diff = 10,
}

export interface ShowcasePreset {
  CurrentPercent: number;
  GraphType: ExperimentGraphOption;
  LineWidth: number;
  LineColor: number;
  SymbolRadius: number;
  SymbolSpacing: number;
  MinimumY: number;
  MaximumY: number;
  ShowIsotherms: boolean;
  LabelBackground: boolean;

  /** thermometers
   * thermometer0.x
   * thermometer0.y
   * ...
   */
  [key: string]: any;
}

export interface ShowcaseData {
  name: string;
  id: string;
  display_name: string;
  author: string;
  description: string;
  subject: ExperimentSubjects;
  duration: number;
  date: string;

  [key: string]: any;
}

export interface Dimension {
  width: number;
  height: number;
  size: number;
}

export interface LineplotData {
  arrayBuffer: ArrayBuffer[];
  step: number;
  secondPerFrame: number;
}

export interface TRating {
  id: string;
  rating: number;
  userId: string;
}

export interface TComment {
  id: string;
  date: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  content: string;
  replyTo?: string; // parent comment id (flat one-level threading)
}
