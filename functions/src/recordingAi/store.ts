/*
 * Persistence of the recording AI's conversations: an Ask AI THREAD (one per user and recording,
 * experiments/{expId}/aiThreads/{uid}) and a report RUN (one per Generate / Revise / Rewrite,
 * experiments/{expId}/aiReportRuns/{runId}). Both hold their turns and images in the app's shapes
 * (labCore/store.ts TurnDoc, ImageDoc), so the app's readers of a conversation draw them unchanged; the
 * server alone writes them (the client rules give the user read of their own). The images' bytes sit in
 * Storage under the conversation's prefix, served by token download URLs as the app's are.
 *
 * The app's functions/src/store.ts is the model for all of this (its lock, its atomic turn numbering,
 * its image saving); rewritten rather than copied because that file is the lab project's.
 */
import { randomUUID } from 'crypto';
import { FieldValue, Timestamp, getFirestore, type DocumentReference } from 'firebase-admin/firestore';
import { getDownloadURL, getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import type { ImageDoc, TurnDoc } from '../labCore/store';
import { LOCK_STALE_MS, RUN_TTL_MS } from './config';

/** A thread (Ask AI), a report run, or the digital twin's agent build (twinAgent/, plan §43.5). */
export type ConvoKind = 'thread' | 'run' | 'twin';

/**
 * A turn of the recording AI: the app's TurnDoc, plus the moments the user attached to a message — their
 * captures of the player, stored as images and named here — which the app's conversations do not have.
 */
export interface RecTurnDoc extends TurnDoc {
  momentImageIds?: string[];
}

export interface ConvoDoc {
  kind: ConvoKind;
  /** The Firebase uid of the user whose conversation this is (the thread's id; the rules read it). */
  uid: string;
  /** The same user's account id, as the experiment documents name owners. */
  mongoId: string;
  expId: string;
  /** Highest turn sequence number written. */
  seq: number;
  /** Held by a running request; stale after LOCK_STALE_MS. */
  lock: { id: string; at: number } | null;
  /** Older turns folded into a summary (turns with seq <= throughSeq). */
  summary: { text: string; throughSeq: number } | null;
  /** The model key (aiModels.ts) the conversation runs on, fixed by its first turn (decision C). */
  model: string;
  usage: { calls: number; input: number; output: number };
  createdAt: number;
  updatedAt: number;
  // ---- a report run only
  mode?: 'revise' | 'rewrite';
  status?: 'running' | 'done' | 'failed';
  /** The labReports document this run writes (labReports/{mongoId}_{uuid}). */
  reportId?: string;
  /** The owner's notes for the report. */
  notes?: string | null;
  /** When the run's documents may go (Firestore TTL policy on this field). */
  expireAt?: Timestamp;
}

/** Where a conversation lives: its document and its Storage prefix. */
export interface Convo {
  kind: ConvoKind;
  expId: string;
  /** The thread's uid, or the run's id. */
  id: string;
  ref: DocumentReference;
  storagePrefix: string;
}

const db = () => getFirestore();
const bucket = () => getStorage().bucket();

export function threadConvo(expId: string, uid: string): Convo {
  return {
    kind: 'thread',
    expId,
    id: uid,
    ref: db().doc(`experiments/${expId}/aiThreads/${uid}`),
    storagePrefix: `aiThreads/${expId}/${uid}`,
  };
}

export function runConvo(expId: string, runId: string): Convo {
  return {
    kind: 'run',
    expId,
    id: runId,
    ref: db().doc(`experiments/${expId}/aiReportRuns/${runId}`),
    storagePrefix: `aiReportRuns/${expId}/${runId}`,
  };
}

/** The twin agent's conversation on a recording (plan §43.5): one per user, like a thread. */
export function twinConvo(expId: string, uid: string): Convo {
  return {
    kind: 'twin',
    expId,
    id: uid,
    ref: db().doc(`experiments/${expId}/twinAgent/${uid}`),
    storagePrefix: `twinAgent/${expId}/${uid}`,
  };
}

export const turnId = (seq: number): string => `t${String(seq).padStart(7, '0')}`;

export function newId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** A labReports document id in the shape every report has had (generateLabReport's {ownerId}_{uuid}). */
export const newReportId = (mongoId: string): string => `${mongoId}_${randomUUID()}`;

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function emptyConvo(
  kind: ConvoKind,
  ids: { uid: string; mongoId: string; expId: string; model: string },
  now: number,
): ConvoDoc {
  const base: ConvoDoc = {
    kind,
    uid: ids.uid,
    mongoId: ids.mongoId,
    expId: ids.expId,
    seq: 0,
    lock: null,
    summary: null,
    model: ids.model,
    usage: { calls: 0, input: 0, output: 0 },
    createdAt: now,
    updatedAt: now,
  };
  return kind === 'run' ? { ...base, status: 'running', expireAt: Timestamp.fromMillis(now + RUN_TTL_MS) } : base;
}

/** Whether a request holds the conversation right now (a crashed one's lock ages out). */
export function lockFresh(c: Pick<ConvoDoc, 'lock'>, now = Date.now()): boolean {
  return c.lock != null && now - c.lock.at < LOCK_STALE_MS;
}

export async function loadConvo(convo: Convo): Promise<ConvoDoc | null> {
  const snap = await convo.ref.get();
  return snap.exists ? (snap.data() as ConvoDoc) : null;
}

/**
 * Take the conversation's lock for one request. Resolves with the document as it was the moment the lock
 * was taken, or null when another request holds a lock younger than LOCK_STALE_MS. A thread that does
 * not exist yet is created here with `create` (its first message takes the lock as it is born); a run is
 * always created before its first request, so `create` is null for it and a missing run is an error.
 */
export async function acquireLock(convo: Convo, lockId: string, create: ConvoDoc | null): Promise<ConvoDoc | null> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(convo.ref);
    const now = Date.now();
    const lock = { id: lockId, at: now };
    const existing = snap.data() as ConvoDoc | undefined;
    if (!existing) {
      if (!create) throw new HttpsError('not-found', 'This conversation no longer exists.');
      const doc = { ...create, lock };
      tx.set(convo.ref, stripUndefined(doc));
      return doc;
    }
    if (lockFresh(existing, now)) return null;
    tx.update(convo.ref, { lock });
    return { ...existing, lock };
  });
}

export async function releaseLock(convo: Convo, lockId: string): Promise<void> {
  await db()
    .runTransaction(async (tx) => {
      const snap = await tx.get(convo.ref);
      const c = snap.data() as ConvoDoc | undefined;
      if (c?.lock?.id === lockId) tx.update(convo.ref, { lock: null });
    })
    .catch((err) => console.warn('recordingAi: lock release failed', convo.ref.path, err));
}

/** Append a turn, assigning the next sequence number atomically. */
export async function appendTurn(convo: Convo, turn: Omit<RecTurnDoc, 'seq' | 'at'>): Promise<RecTurnDoc> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(convo.ref);
    const c = snap.data() as ConvoDoc | undefined;
    if (!c) throw new HttpsError('not-found', 'This conversation no longer exists.');
    const seq = (c.seq ?? 0) + 1;
    const full = stripUndefined({ ...turn, seq, at: Date.now() }) as RecTurnDoc;
    tx.set(convo.ref.collection('turns').doc(turnId(seq)), full);
    tx.update(convo.ref, { seq, updatedAt: full.at });
    return full;
  });
}

export async function loadTurns(convo: Convo, afterSeq = 0): Promise<RecTurnDoc[]> {
  const snap = await convo.ref.collection('turns').where('seq', '>', afterSeq).orderBy('seq', 'asc').get();
  return snap.docs.map((d) => d.data() as RecTurnDoc);
}

export async function loadImages(convo: Convo): Promise<ImageDoc[]> {
  const snap = await convo.ref.collection('images').get();
  return snap.docs.map((d) => d.data() as ImageDoc).sort((a, b) => a.at - b.at);
}

export async function updateConvo(convo: Convo, patch: Partial<ConvoDoc>): Promise<void> {
  await convo.ref.update(stripUndefined({ ...patch, updatedAt: Date.now() }));
}

export async function addUsage(
  convo: Convo,
  usage: { calls?: number; input?: number; output?: number },
): Promise<void> {
  const inc = (n?: number) => FieldValue.increment(n ?? 0);
  await convo.ref
    .update({ 'usage.calls': inc(usage.calls), 'usage.input': inc(usage.input), 'usage.output': inc(usage.output) })
    .catch(() => undefined);
}

// ------------------------------------------------------------------ images

export function extFor(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

/** Store an image's bytes under the conversation and its metadata document; resolves with the document. */
export async function saveImage(
  convo: Convo,
  img: { mime: string; b64: string },
  meta: Omit<ImageDoc, 'id' | 'path' | 'url' | 'at' | 'mime'>,
): Promise<ImageDoc> {
  const id = newId('img');
  const mime = img.mime || 'image/jpeg';
  const path = `${convo.storagePrefix}/${id}.${extFor(mime)}`;
  const file = bucket().file(path);
  await file.save(Buffer.from(img.b64, 'base64'), {
    resumable: false,
    contentType: mime,
    metadata: { cacheControl: 'private, max-age=31536000' },
  });
  const url = await getDownloadURL(file);
  const doc = stripUndefined({ ...meta, id, path, mime, url, at: Date.now() }) as ImageDoc;
  await convo.ref.collection('images').doc(id).set(doc);
  return doc;
}

const imageBytesCache = new Map<string, { mime: string; b64: string }>();

/** An image's bytes as base64 (cached for the life of the instance). */
export async function imageBytes(doc: Pick<ImageDoc, 'path' | 'mime'>): Promise<{ mime: string; b64: string }> {
  const hit = imageBytesCache.get(doc.path);
  if (hit) return hit;
  const [buf] = await bucket().file(doc.path).download();
  const value = { mime: doc.mime, b64: buf.toString('base64') };
  if (imageBytesCache.size > 200) imageBytesCache.clear();
  imageBytesCache.set(doc.path, value);
  return value;
}

/** Remember bytes we already hold (a fresh upload) so the next read skips Storage. */
export function primeImageBytes(doc: Pick<ImageDoc, 'path' | 'mime'>, b64: string): void {
  imageBytesCache.set(doc.path, { mime: doc.mime, b64 });
}

/**
 * An image's bytes copied to another path (a report's own prefix), with the copy's download URL — so the
 * report's pictures outlive the conversation that made them. Throws when the copy fails.
 */
export async function copyImage(
  img: Pick<ImageDoc, 'path' | 'mime'>,
  toPath: string,
): Promise<{ path: string; url: string }> {
  const dest = bucket().file(toPath);
  const [exists] = await dest.exists();
  if (!exists) await bucket().file(img.path).copy(dest);
  return { path: toPath, url: await getDownloadURL(dest) };
}

/** Delete a conversation whole: its document, subcollections and pictures. */
export async function deleteConvo(convo: Convo): Promise<void> {
  await db().recursiveDelete(convo.ref);
  await bucket()
    .deleteFiles({ prefix: `${convo.storagePrefix}/` })
    .catch((err) => console.warn('recordingAi: storage delete failed', convo.storagePrefix, err));
}

/** Firestore rejects `undefined` values; drop them (shallow and in arrays of plain objects). */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as unknown as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
