export interface User {
  displayName: string | null;
  email: string | null;
  avatar: string | null;
  id: string;
}

export enum ExperimentType {
  Video = 'video',
  Image = 'image',
}

export type Segment = { start: number; end: number };

export enum TemperatureUnit {
  celsius = 'celsius',
  fahrenheit = 'fahrenheit',
}

export interface Experiment {
  recordingId?: string;
  segments: { start: number; end: number }[];

  name: string; // this is the name of the file (the old MP4-based experiment needs this)
  displayName: string; // this is the title
  author: string;
  description: string;
  active: boolean; // the server side uses this name to indicate if the experiment is live
  viewCount?: number;
  disallowCopy?: boolean;
  subject: ExperimentSubjects | null;
  duration: number;
  currentPercent?: number; // remember the last viewed frame of a recorded MP4 experiment (in percentage)
  currentFrameNumber?: number;
  currentFrameNumberInJoinedSegments?: number;
  date: string;
  // type: ExperimentTypes;
  // unit: ExperimentThermalUnits;
  thumbnailURL: string;

  readonly id: string;
  readonly videoURL: string;
  readonly thermoURL: string;
  readonly presetURL: string;

  graphsOptions?: ExperimentGraphOption[];
  thermometersId: string[];
  commentsId?: string[];
  // preset?: ExperimentPresetRawData;
  timeStamp?: string;

  // lineplot?: Lineplot;
  // scatterplotX?: Scatterplot;
  // scatterplotY?: Scatterplot;

  // annotations?: Annotation[];
}

export interface Thermometer {
  id: string;
  x: number;
  y: number;
  value: number;
  unit: TemperatureUnit;
}

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

  // others
  microphone = 'microphone',
  audio = 'audio',
  requestPiCarControl = 'requestControl',
  resetPiCarControl = 'resetPiCarControl',
  roster = 'Roster',
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

export enum ExperimentSubjects {
  NA = 'not available',
  Chemistry = 'chemistry',
  Physics = 'physics',
  Biology = 'biology',
}

export enum ExperimentTypes {
  Recording = 'recording', // legacy
  Streaming = 'streaming',
  LiveRecording = 'live-recording',
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
  content: string;
  reply?: TComment[];
}
