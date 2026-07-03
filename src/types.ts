import type { Timestamp } from 'firebase/firestore';

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
 * Persistent Firestore shape at `experiments/{expId}` (the merged showcase + user-clip
 * collection). Aggregates (ratingSum/ratingCount/viewCount) are maintained by Functions
 * and are read-only from the client. See docs/telelab-migration.md §4.
 */
export interface ExperimentDoc {
  sourceType: ExperimentType;
  ownerId: string; // mongoId, or 'system' for showcases
  visibility: Visibility;

  displayName: string;
  author: string;
  description: string;
  subject: ExperimentSubjects | null;
  duration: number;
  date: string;
  thumbnailURL: string;

  graphsOptions?: ExperimentGraphOption[];
  thermalUnit: TemperatureUnit;

  createdAt?: Timestamp; // server-set on create/clone; absent on some legacy docs
  updatedAt?: Timestamp; // server-set on every edit (rename/describe/retag/trash/…); absent until first edit
  trash: boolean;
  isRaw: boolean; // untrimmed source clip (mirrors segments == null for indexable queries)
  segments: Segment[] | null;

  name?: string; // video-only: videostore slug
  recordingId?: string; // recording-only
  // video-only: set on a clone that was saved with edited thermometers. They then live in the
  // thermometers subcollection and are loaded from there, instead of re-derived from the .wrk preset.
  customThermometers?: boolean;

  // AI lab report (Markdown), written by the generateLabReport Cloud Function (owner only).
  aiReport?: string;
  aiReportAt?: Timestamp;
  aiReportModel?: QaModel; // which model produced the saved report (for the UI badge)

  // Function-maintained aggregates (client read-only).
  ratingSum: number;
  ratingCount: number;
  viewCount: number;
  commentCount: number;
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
  thermometersId: string[];
  commentsId?: string[];
  timeStamp?: string;

  // Merged-collection fields (optional during migration; populated from ExperimentDoc).
  sourceType?: ExperimentType;
  ownerId?: string;
  visibility?: Visibility;
  customThermometers?: boolean; // video-only: thermometers persisted in the subcollection (see ExperimentDoc)
  thermalUnit?: TemperatureUnit;
  trash?: boolean;
  isRaw?: boolean;
  ratingSum?: number;
  ratingCount?: number;
  commentCount?: number;
  aiReport?: string; // AI-generated lab report (Markdown); see ExperimentDoc.aiReport
  aiReportModel?: QaModel; // model that produced aiReport; see ExperimentDoc.aiReportModel
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

// Selectable model for the free-form AI Q&A. Default 'sonnet' (cheaper); 'opus' for a deeper pass;
// 'deepseek' is a text-only third-party alternative. Maps to concrete model ids server-side (see
// QA_MODELS in functions/src/index.ts).
export type QaModel = 'sonnet' | 'opus' | 'deepseek';

// Selectable model for the site-wide Lab Assistant agent. Sonnet (fast/cheap default) and Opus run on
// Claude; DeepSeek is a lower-cost alternative whose OpenAI-compatible API drives the same tool loop.
// Maps to concrete ids server-side (AGENT_MODELS in functions/src/index.ts).
export type AgentModel = 'sonnet' | 'opus' | 'deepseek';

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
}

// Toolbar pages cycled through with the up/down arrows (telelab ControlBarState parity).
export type ToolPage = 'analyze' | 'clip' | 'annotate';

export enum ControlBarButtons {
  // arrow buttons
  upArrow = 'Up',
  downArrow = 'Down',
  // analyze mode
  addThermometer = 'Add Thermometer',
  graphT = 'T(t)',
  graphX = 'T(x)',
  graphY = 'T(y)',
  graphR = 'T(r)',
  isotherms = 'Isotherms',
  noGraph = 'No Graph',
  clearData = 'Clear Data',
  changeUnit = 'Change Unit',
  takeScreenshot = 'Take Screenshot',
  // edit clip mode
  addClip = 'Add',
  undo = 'Undo',
  reset = 'Reset',
  save = 'Save as',
  // edit annotation mode
  addAnnotation = 'Add Annotation',
  rewordAnnotation = 'Revise Annotation',
}

export enum ExperimentGraphOption {
  noGraph = 0,
  time = 1,
  spaceX = 2,
  spaceY = 3,
  spaceR = 4,
  isotherm = 5,
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
