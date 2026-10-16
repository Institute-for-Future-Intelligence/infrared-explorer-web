/*
 * The lab-projects wire contract, as the app sees it. Mirrors the DTOs of the
 * `labprojects` Cloud Functions codebase (functions/src/store.ts and
 * functions/src/turn.ts in this repository) — change both together.
 */

import type {AiSensor} from './aiSensors';

export interface Take {
  takeId: string;
  /** The gallery item's path on the phone that captured or imported it. */
  localPath: string;
  source: 'recording' | 'photos';
  timelapse: boolean;
  name: string;
  /** The AI has been told about it (a message carried it). Until then it waits beside the message box. */
  announced: boolean;
  at: number;
  /** Its number in the project (Capture 1, 2, … in the order added); see captureNumbers. */
  n?: number;
  /** Its copy in the cloud, uploaded while the project was shared (sharing.ts). */
  cloud?: {expId: string; at: number};
  /** The AI's sensors on it, as sent up for viewers while the project is shared (aiSensors.ts keeps the phone's copy). */
  aiSensors?: AiSensor[];
}

/** The current plan only; earlier wordings are not kept. */
export interface Plan {
  markdown: string;
  by: 'ai' | 'user';
  at: number;
}

export interface Report {
  title: string;
  markdown: string;
  at: number;
}

export type ProjectStatus = 'designing' | 'reviewing' | 'reported';

/** How a project is shared (docs/proposals/lab-project-sharing.md): nobody, anyone with the link, or Community too. */
export type ShareVisibility = 'private' | 'unlisted' | 'public';

/** The owner's view of a shared project; null = private. */
export interface ShareInfo {
  visibility: 'unlisted' | 'public';
  /** The link: https://ie.intofuture.org/projects/<id>?k=<token>. */
  url: string;
  /** Staff took it out of Community; it opens for nobody but the owner. */
  takenDown: boolean;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  plan: Plan | null;
  takes: Take[];
  report: Report | null;
  seq: number;
  status: ProjectStatus;
  /** A turn is running on the server right now. */
  busy: boolean;
  /** The model the conversation runs on (key null: a project from before there was a choice). */
  chatModel?: {key: string | null; label: string};
  /** The models the user may still switch to; null once the conversation has started. */
  modelChoices?: {key: string; label: string}[] | null;
  /** How it is shared; null = private (absent from a server older than sharing). */
  share?: ShareInfo | null;
  /**
   * The project is on the cloud for the website (Upload to Cloud, or shared;
   * docs/proposals/ai-projects-web.md): when it went up. Null or absent while
   * it lives on this phone alone.
   */
  web?: {at: number} | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  updatedAt: number;
  createdAt: number;
  /** Each take's path on the phone that filed it; `cloud` (absent from an older server) says it has a copy in the cloud. */
  takePaths: {takeId: string; localPath: string; cloud?: boolean}[];
  lastText: string;
  coverUrl: string | null;
  /**
   * The label of the model that wrote the latest reply, or before the first
   * reply the one the conversation runs on (absent in a list an older server
   * sent; an older server sent the one it runs on).
   */
  model?: string;
  /** How it is shared (absent in a list an older server sent: private). */
  visibility?: ShareVisibility;
  /** Staff took it out of Community. */
  takenDown?: boolean;
  /**
   * A turn holds the project on the server right now (absent in a list an
   * older server sent). A run this phone drives is known from runner.ts.
   */
  busy?: boolean;
  /** When it went on the cloud for the website; null or absent while it lives on this phone alone. */
  web?: number | null;
}

// ----------------------------------------------------------------- shared

/** A take as a viewer sees it: no phone path, nothing waiting beside a box. */
export interface SharedTake {
  takeId: string;
  source: 'recording' | 'photos';
  timelapse: boolean;
  name: string;
  at: number;
  n?: number;
  cloud?: {expId: string};
  aiSensors?: AiSensor[];
}

export interface SharedProject {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  plan: Plan | null;
  takes: SharedTake[];
  report: Report | null;
  seq: number;
  status: ProjectStatus;
  /** A turn is running for the owner right now. */
  busy: boolean;
  chatModel?: {key: string | null; label: string};
  visibility: 'unlisted' | 'public';
}

export interface SharedOwner {
  /** The owner's mongoId (profiles and the author block list key on it); null when unknown. */
  id: string | null;
  name: string;
}

/** What labProjectOpenShared answers: the whole project, read-only. */
export interface SharedBundle {
  project: SharedProject;
  turns: Turn[];
  images: ProjectImage[];
  owner: SharedOwner;
  /** The caller is signed in as the owner: the ordinary page is the one to open. */
  isOwner: boolean;
  readOnly: true;
}

/** A public project as Community lists it. */
export interface CommunityProject {
  id: string;
  title: string;
  status: ProjectStatus;
  publicAt: number;
  updatedAt: number;
  coverUrl: string | null;
  takeCount: number;
  owner: SharedOwner;
  /** What the model that wrote the latest reply is called, else the one it runs on (absent from an older server). */
  model?: string;
}

export interface CommunityProjectCursor {
  publicAt: number;
  id: string;
}

export interface CommunityProjectPage {
  projects: CommunityProject[];
  cursor: CommunityProjectCursor | null;
  hasMore: boolean;
}

export interface StoredToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments. */
  args: string;
  side: 'server' | 'phone';
}

/** Something the user did outside the conversation, recorded in it for the AI. */
export type Note = {type: 'planEdited'; diff: string} | {type: 'takeRemoved'; takeId: string; name: string; n?: number};

export interface Turn {
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'event' | 'note';
  at: number;
  text?: string;
  attachments?: {takeId: string}[];
  toolCalls?: StoredToolCall[];
  callId?: string;
  name?: string;
  ok?: boolean;
  result?: {text: string; imageIds: string[]};
  /** New takes: on a user turn the captures sent with it; on an (older) event turn the ones announced. */
  event?: {
    type: 'takesAdded';
    takes: {takeId: string; overview: string}[];
    imageIds: string[];
  };
  note?: Note;
  /** A user turn that is a button, not words: Generate Report in the Report tab. */
  request?: 'report';
  /** An assistant turn: the model that wrote it, as `provider/model`. */
  model?: string;
  /** What that model is called, the picker's label (absent from an older server). */
  modelLabel?: string;
}

export type ImageKind = 'diagram' | 'look' | 'overview';

export interface ProjectImage {
  id: string;
  kind: ImageKind;
  path: string;
  mime: string;
  caption: string;
  url: string;
  at: number;
  prompt?: string;
  editOf?: string;
  lineage?: string;
  version?: number;
  takeId?: string;
}

export interface ProjectBundle {
  project: Project;
  turns: Turn[];
  images: ProjectImage[];
}

/** An image the phone sends up (a rendered frame, an overview sheet, a chart). */
export interface OutImage {
  mime: 'image/jpeg' | 'image/png';
  b64: string;
  caption: string;
  takeId?: string;
}

export interface PhoneToolResult {
  callId: string;
  ok: boolean;
  text: string;
  images?: OutImage[];
}

export type TurnInput =
  | {
      kind: 'message';
      text: string;
      attachments?: {takeId: string}[];
      /** Captures sent with the message (they waited beside the box), each with the app's overview. */
      takes?: {takeId: string; overview: string}[];
      images?: OutImage[];
    }
  | {kind: 'toolResults'; results: PhoneToolResult[]}
  | {kind: 'event'; takes: {takeId: string; overview: string}[]; images?: OutImage[]}
  | {kind: 'report'}
  | {kind: 'resume'};

export interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/** What the account has left (functions/src/quota.ts quotaLeft); null for staff, who have no limit. */
export interface QuotaLeft {
  hourLeft: number;
  dayLeft: number;
  hourLimit: number;
  dayLimit: number;
}

export interface TurnOutcome {
  status: 'done' | 'awaitingPhone' | 'busy' | 'limit';
  pending: PendingCall[];
  project: Project;
  /** After this request; absent from a server older than the quotas. */
  quota?: QuotaLeft | null;
}

/**
 * The line the page shows about what is left, or null while there is
 * plenty: only the last three turns of the tighter window are announced,
 * so the limit is not in the way until it is about to be.
 */
export function quotaLine(quota: QuotaLeft | null | undefined): string | null {
  if (!quota) {
    return null;
  }
  const day = quota.dayLeft;
  const hour = quota.hourLeft;
  if (day > 3 && hour > 3) {
    return null;
  }
  const n = Math.min(day, hour);
  const when = day <= hour ? 'today' : 'this hour';
  return `${n} AI ${n === 1 ? 'turn' : 'turns'} left ${when}`;
}

/** What the server streams while a turn runs. */
export type StreamChunk =
  | {t: 'text'; d: string}
  | {t: 'turn'; turn: Turn}
  | {t: 'project'; project: Project}
  | {t: 'image'; image: ProjectImage}
  | {t: 'status'; s: string; tool?: string; caption?: string}
  | {t: 'preview'; tool: string; text: string};

/** The phone tools this build can run — sent with every turn. */
export const PHONE_TOOLS = ['look', 'measure', 'chart', 'place_sensors', 'run_code'] as const;
