/*
 * Shim for the app repository's functions/src/store.ts: the document TYPES the synced prompt.ts names
 * (ProjectDoc, ImageDoc and what they are made of), copied from the app's store.ts — types only, none of
 * its Firestore code. The recording AI's own store (../recordingAi/store.ts) keeps its conversations in
 * these same shapes (TurnDoc, ImageDoc, StoredToolCall), so the app's replies / Discuss readers on the
 * website draw them unchanged. Not synced; see SOURCE.md. Keep in step with the app's store.ts.
 */
import type { WebSearch } from './llm';

export interface TakeRec {
  takeId: string;
  /** The item's path on the phone that recorded or imported it. */
  localPath: string;
  source: 'recording' | 'photos';
  timelapse: boolean;
  name: string;
  /** The model has been told about this take. */
  announced: boolean;
  at: number;
  /** Its number in the project, as the user sees it (Capture 1, 2, …). */
  n?: number;
  /** Its copy in the cloud, an experiment. */
  cloud?: { expId: string; at: number };
  device?: string;
  aiSensors?: AiSensorRec[];
}

export interface PlanRec {
  markdown: string;
  by: 'ai' | 'user';
  at: number;
}

export interface ReportRec {
  title: string;
  markdown: string;
  /** When this wording was saved: the model's write_report, or the user's edit. */
  at: number;
  /** Absent = the model's own writing. */
  by?: 'ai' | 'user';
}

export interface ShareRec {
  token: string;
  at: number;
  publicAt: number | null;
  takenDown?: { at: number; by: string };
}

export interface AiSensorRec {
  x: number;
  y: number;
  name?: string;
  color?: string;
  width?: number;
  shape?: number;
  userStyled?: boolean;
  aiPlaced?: boolean;
  area?: { kind: 'point' | 'rect' | 'ellipse'; w: number; h: number };
}

export interface ProjectDoc {
  ownerUid: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  plan: PlanRec | null;
  takes: TakeRec[];
  report: ReportRec | null;
  seq: number;
  lock: { id: string; at: number } | null;
  summary: { text: string; throughSeq: number } | null;
  usage: { calls: number; input: number; output: number; images: number };
  lastText: string;
  lastModel?: string;
  coverUrl?: string | null;
  chatModel?: string | null;
  takeCount?: number;
  share?: ShareRec | null;
  web?: { at: number } | null;
  device?: string;
}

export type TurnRole = 'user' | 'assistant' | 'tool' | 'event' | 'note';

export type NoteRec =
  | { type: 'planEdited'; diff: string }
  /** `title`: the new title, when the edit changed it. */
  | { type: 'reportEdited'; diff: string; title?: string }
  | { type: 'takeRemoved'; takeId: string; name: string; n?: number };

export interface StoredToolCall {
  id: string;
  name: string;
  args: string;
  side: 'server' | 'phone';
  /** Gemini's thought signature for the call (labCore/llm.ts ToolCall.signature), sent back with it. */
  signature?: string;
}

export interface TurnDoc {
  seq: number;
  role: TurnRole;
  at: number;
  text?: string;
  attachments?: { takeId: string }[];
  toolCalls?: StoredToolCall[];
  callId?: string;
  name?: string;
  ok?: boolean;
  result?: { text: string; imageIds: string[] };
  /** New takes with the app's overview of each, on the user turn that carried them. */
  event?: {
    type: 'takesAdded';
    takes: { takeId: string; overview: string }[];
    imageIds: string[];
  };
  note?: NoteRec;
  /** A user turn that is a button, not words: Generate Report. */
  request?: 'report';
  model?: string;
  /** On an assistant turn, the web searches the model ran while writing it (OpenAI only). */
  webSearches?: WebSearch[];
}

export type ImageKind = 'diagram' | 'look' | 'overview';

export interface ImageDoc {
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
  provider?: string;
  model?: string;
}
