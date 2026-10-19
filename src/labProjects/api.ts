/*
 * The AI Project section's calls to the app's `labprojects` Cloud Functions
 * codebase (us-central1; deployed from the app repository, not this one).
 * Every read of a project goes through these callables: the `labProjects`
 * collection has no client rules. Typed with the wire contract the app uses
 * (core/types.ts, a synced copy).
 *
 * P0 of docs/proposals/ai-projects-web.md (app repository): list, get, open
 * shared. P1: create, edit, delete, share, the quota, the AI data consent,
 * and a conversation turn streamed with httpsCallable's `stream()` — the
 * app reads the same SSE over XMLHttpRequest (its api.ts streamTurn); the
 * chunks are the same (core/types.ts StreamChunk). P2: a capture filed from
 * My Experiments (attachExperiment) and taken out again (removeTakeId). P3:
 * the public projects Community lists (listCommunityProjects).
 */

import { FirebaseError } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { firebaseApp } from '../services/firebase';
import { BROWSER_TOOLS } from './browserTools';
import type {
  CommunityProjectCursor,
  CommunityProjectPage,
  Project,
  ProjectBundle,
  ProjectSummary,
  QuotaLeft,
  SharedBundle,
  ShareVisibility,
  StreamChunk,
  Take,
  TurnInput,
  TurnOutcome,
} from './core/types';

/**
 * The `labprojects` codebase is deployed from the app repository, so it is
 * never in this repository's Functions emulator: with VITE_USE_EMULATORS /
 * VITE_USE_FUNCTIONS_EMULATOR on, the shared `firebaseFunctions` instance
 * would send these calls to 127.0.0.1:5001, where they 404 with no CORS
 * header ("internal"). This instance is pinned to production by its custom
 * domain — a different instance key, so connectFunctionsEmulator in
 * services/firebase.ts does not touch it — and still signs calls with the
 * app's auth, since it shares the Firebase app.
 */
const labProjectFunctions = getFunctions(
  firebaseApp,
  `https://us-central1-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net`,
);

async function call<T>(name: string, data: Record<string, unknown>): Promise<T> {
  const fn = httpsCallable<Record<string, unknown>, T>(labProjectFunctions, name);
  const r = await fn(data);
  return r.data;
}

/**
 * The callable's error code without its `functions/` prefix
 * ('permission-denied', 'not-found', 'unauthenticated', …), or null for
 * anything that is not a callable error.
 */
export function callableCode(e: unknown): string | null {
  const code = e instanceof FirebaseError ? e.code : (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.replace(/^functions\//, '') : null;
}

/**
 * The signed-in account's projects that are on the cloud for the website
 * (uploaded from the app, or shared), newest first. `client: 'web'` is what
 * asks the server for that subset.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const r = await call<{ projects?: ProjectSummary[] }>('labProjectList', { client: 'web' });
  return Array.isArray(r?.projects) ? r.projects : [];
}

/** One of the account's own projects, whole; permission-denied when it belongs to someone else. */
export async function getProject(projectId: string): Promise<ProjectBundle> {
  const r = await call<ProjectBundle>('labProjectGet', { projectId });
  return {
    project: r.project,
    turns: Array.isArray(r.turns) ? r.turns : [],
    images: Array.isArray(r.images) ? r.images : [],
  };
}

/**
 * A shared project, read-only, for whoever holds its link: a public one
 * opens without the token, a link-only one needs it. Needs no account. Every
 * failure is the same not-found.
 */
export async function openSharedProject(projectId: string, token?: string | null): Promise<SharedBundle> {
  const r = await call<SharedBundle>('labProjectOpenShared', token ? { projectId, token } : { projectId });
  return {
    ...r,
    turns: Array.isArray(r.turns) ? r.turns : [],
    images: Array.isArray(r.images) ? r.images : [],
    owner: r.owner ?? { id: null, name: 'Someone' },
    isOwner: r.isOwner === true,
    readOnly: true,
  };
}

/**
 * A copy of a project under this account (labProjectCopy) — the whole project
 * as a viewer sees it, private: "Save as…" on someone else's
 * shared one (`token` is the link's `k`; a public project needs none), or the
 * owner's "Save as…" of their own. `title` names the copy; without it the copy
 * keeps the original's. Needs an account.
 */
export async function copySharedProject(projectId: string, token?: string | null, title?: string): Promise<Project> {
  const r = await call<{ project: Project }>('labProjectCopy', {
    projectId,
    ...(token ? { token } : {}),
    ...(title ? { title } : {}),
  });
  return r.project;
}

/**
 * The projects their owners made public, newest first, a page at a time
 * (the server's COMMUNITY_PAGE, 24); `after` is the cursor the last page
 * came with. Needs no account. The server leaves out the ones staff took
 * down. The app's CommunityScreen reads the same callable.
 */
export async function listCommunityProjects(
  after: CommunityProjectCursor | null = null,
): Promise<CommunityProjectPage> {
  const r = await call<Partial<CommunityProjectPage>>('labProjectCommunityList', after ? { after } : {});
  const cursor = r?.cursor;
  return {
    projects: Array.isArray(r?.projects) ? r.projects : [],
    cursor:
      cursor && typeof cursor.publicAt === 'number' && typeof cursor.id === 'string'
        ? { publicAt: cursor.publicAt, id: cursor.id }
        : null,
    hasMore: r?.hasMore === true,
  };
}

// ------------------------------------------------------------- the owner's

/** A new, empty project ("Untitled Project"); one the website makes is on the cloud from the start. */
export async function createProject(): Promise<Project> {
  const r = await call<{ project: Project }>('labProjectCreate', { client: 'web' });
  return r.project;
}

export interface EditPatch {
  title?: string;
  /** Only while `project.modelChoices` is set (before the first message). */
  chatModel?: string;
  planMarkdown?: string;
  /** The user's edit of the report (both go together; core/markdown splitReportTitle on what the editor hands back). */
  reportTitle?: string;
  reportMarkdown?: string;
  /** Take a capture out of the project (it stays in My Experiments). The server records a note of it in the conversation. */
  removeTakeId?: string;
}

/**
 * File one of the account's experiments (a recording or a photo set) under
 * the project as a take: it comes back with no phone path, its cloud copy
 * set (`cloud.expId`), unannounced — it waits beside the message box until
 * a message carries it to the AI with its overview (overview.ts).
 */
export async function attachExperiment(projectId: string, expId: string): Promise<{ project: Project; take: Take }> {
  return call<{ project: Project; take: Take }>('labProjectAttach', { projectId, take: { expId } });
}

/** The user's own edits: rename, pick the model, save an edited plan, remove a capture. The server adds a note of a plan edit or a removal to the conversation. */
export async function editProject(projectId: string, patch: EditPatch): Promise<Project> {
  const r = await call<{ project: Project }>('labProjectEdit', { projectId, ...patch });
  return r.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await call('labProjectDelete', { projectId });
}

/** How the owner shares the project; the server refuses an empty project and an anonymous account. */
export async function shareProject(projectId: string, visibility: ShareVisibility): Promise<Project> {
  const r = await call<{ project: Project }>('labProjectShare', { projectId, visibility });
  return r.project;
}

/** What this account has left of its AI turns; null for staff, who have no limit. */
export async function fetchQuota(): Promise<QuotaLeft | null> {
  const r = await call<{ quota: QuotaLeft | null }>('labProjectQuota', {});
  return r?.quota ?? null;
}

/** Record the AI data agreement on the server (labProjectsConsent/{uid}); the app sends its version, the site its build. */
export async function recordConsent(): Promise<void> {
  await call('labProjectConsent', { platform: 'web', appVersion: __BUILD_TIME__ });
}

// ------------------------------------------------------------- streaming

/** A turn's request lasts at most the function's 540 s, plus slack (the app's TURN_TIMEOUT_MS). */
const TURN_TIMEOUT_MS = 570_000;

export class TurnError extends Error {
  constructor(
    message: string,
    /** The callable's code without its prefix, or null when the failure was not the server's. */
    readonly code: string | null,
    /** Stop was pressed: not a failure. */
    readonly cancelled = false,
  ) {
    super(message);
  }
}

export interface TurnRequest {
  done: Promise<TurnOutcome>;
  /** Drops the connection. The server finishes the step it is on and persists it. */
  abort(): void;
}

/**
 * One request to labProjectTurn, streamed: each chunk goes to `onChunk` as
 * it arrives, `done` settles with the outcome. The website declares the
 * tools it can run in the browser (browserTools.ts BROWSER_TOOLS: look and
 * run_code over the captures' cloud copies); a call for one of them comes
 * back as `awaitingPhone` with the call, and the runner answers it with
 * `toolResults` in the next request.
 */
export function streamTurn(opts: {
  projectId: string;
  input: TurnInput;
  onChunk: (chunk: StreamChunk) => void;
}): TurnRequest {
  const controller = new AbortController();
  const done = (async (): Promise<TurnOutcome> => {
    const fn = httpsCallable<Record<string, unknown>, TurnOutcome, StreamChunk>(labProjectFunctions, 'labProjectTurn', {
      timeout: TURN_TIMEOUT_MS,
    });
    try {
      const { stream, data } = await fn.stream(
        { projectId: opts.projectId, input: opts.input, phoneTools: [...BROWSER_TOOLS], client: 'web' },
        { signal: controller.signal },
      );
      // The SDK rejects both the iterator and this promise on a mid-stream error; the loop throws
      // first, so this rejection is marked handled and `await data` below still surfaces it.
      void data.catch(() => {});
      for await (const chunk of stream) {
        if (chunk && typeof chunk === 'object' && 't' in chunk) {
          try {
            opts.onChunk(chunk);
          } catch {
            // a rendering problem must not kill the stream
          }
        }
      }
      return await data;
    } catch (e) {
      if (controller.signal.aborted) {
        throw new TurnError('Cancelled.', null, true);
      }
      const code = callableCode(e);
      const raw = (e as Error)?.message ?? '';
      // the SDK's own word for a request that never reached the function
      const message =
        code === 'internal' && (!raw || raw === 'internal')
          ? 'Could not reach the AI. Check the connection and try again.'
          : code === 'deadline-exceeded'
            ? 'The answer took too long.'
            : raw || 'Something went wrong.';
      throw new TurnError(message, code);
    }
  })();
  done.catch(() => undefined);
  return { done, abort: () => controller.abort() };
}
