import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { firebaseDatabase, firebaseFunctions } from './firebase';
import { toStreetView } from '../utils/streetView';
import type { StreetView } from '../types';

/*
 * Street-view moderation, seen from the website: filing a report, a staff verdict, the block
 * list, and the reads the admin queue is built from.
 *
 * The map has no pre-publication review — a report is what acts, and it acts by itself within
 * seconds. Every decision behind that lives server-side (functions/src/moderation.ts); nothing
 * here is a check, only a way to ask. The scheme is written up in the app repo,
 * docs/proposals/street-view-ugc-governance.md.
 */

export type ReportReason = 'privacy' | 'inappropriate' | 'wrong_location' | 'spam' | 'other';

/** The reasons, in the order both clients list them. Labels match the staff e-mail's wording. */
export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'privacy', label: 'Privacy — a person, a licence plate or inside a home' },
  { value: 'inappropriate', label: 'Inappropriate or offensive' },
  { value: 'wrong_location', label: 'Wrong place on the map' },
  { value: 'spam', label: 'Spam or not a street view' },
  { value: 'other', label: 'Something else' },
];

export const MAX_REPORT_DETAILS = 500;

export interface ReportRequest {
  targetType: 'streetview' | 'author';
  svId?: string;
  authorId?: string;
  reason: ReportReason;
  details?: string;
}

export interface ReportResult {
  ok: boolean;
  /** This person already has an open report on this target; nothing was counted twice. */
  duplicate: boolean;
  /** The panorama is off the map now — either this report hid it, or it already was. */
  hidden: boolean;
}

/** File a report. Works signed out: the callable takes an optional caller. */
export async function submitStreetViewReport(req: ReportRequest): Promise<ReportResult> {
  const fn = httpsCallable<ReportRequest, ReportResult>(firebaseFunctions, 'reportStreetView');
  const res = await fn({ ...req, details: req.details ?? '' });
  return res.data;
}

interface ReviewResult {
  ok: boolean;
  reportsClosed: number;
  legacy?: boolean;
}

/** Staff verdict on a panorama. `restore` also makes it immune to further auto-hiding. */
export async function reviewStreetView(
  svId: string,
  action: 'restore' | 'remove',
  note?: string,
): Promise<ReviewResult> {
  const fn = httpsCallable<{ svId: string; action: string; note?: string }, ReviewResult>(
    firebaseFunctions,
    'reviewStreetView',
  );
  return (await fn({ svId, action, note })).data;
}

/** Staff: stop an account publishing anything more, or let it publish again. */
export async function suspendAuthor(
  ownerId: string,
  suspend: boolean,
  reason?: string,
): Promise<{ ok: boolean; suspended: boolean }> {
  const fn = httpsCallable<{ ownerId: string; suspend: boolean; reason?: string }, { ok: boolean; suspended: boolean }>(
    firebaseFunctions,
    'suspendAuthor',
  );
  return (await fn({ ownerId, suspend, reason })).data;
}

/**
 * Staff: close a report that no content action answers — one about an author, or one whose
 * panorama the owner has already deleted. `kept` is the outcome that counts against the filer.
 */
export async function resolveReport(
  reportId: string,
  outcome: 'kept' | 'removed' | 'suspended',
): Promise<{ ok: boolean; alreadyClosed: boolean }> {
  const fn = httpsCallable<{ reportId: string; outcome: string }, { ok: boolean; alreadyClosed: boolean }>(
    firebaseFunctions,
    'resolveStreetViewReport',
  );
  return (await fn({ reportId, outcome })).data;
}

// ---- The viewer's block list ----------------------------------------------------------

export interface BlockedAuthor {
  authorId: string;
  authorName: string;
  createdAtMillis: number | null;
}

/**
 * Everyone this account has hidden. Blocking is a per-viewer filter applied after the fetch —
 * Firestore has no NOT-IN of arbitrary length, so the documents still arrive and the client
 * drops them (proposal §13 says so out loud rather than implying otherwise).
 */
export async function listBlockedAuthors(mongoId: string): Promise<BlockedAuthor[]> {
  const snap = await getDocs(collection(firebaseDatabase, `users/${mongoId}/blocks`));
  const rows = snap.docs.map((d) => {
    const data = d.data();
    return {
      authorId: (data.authorId as string) ?? d.id,
      authorName: (data.authorName as string) ?? '',
      createdAtMillis: data.createdAt?.toMillis?.() ?? null,
    };
  });
  rows.sort((a, b) => (b.createdAtMillis ?? 0) - (a.createdAtMillis ?? 0));
  return rows;
}

export async function blockAuthor(mongoId: string, authorId: string, authorName: string): Promise<void> {
  // The rules accept exactly these three keys and cap the name at 120 characters.
  await setDoc(doc(firebaseDatabase, `users/${mongoId}/blocks/${authorId}`), {
    authorId,
    authorName: authorName.slice(0, 120),
    createdAt: serverTimestamp(),
  });
}

export async function unblockAuthor(mongoId: string, authorId: string): Promise<void> {
  await deleteDoc(doc(firebaseDatabase, `users/${mongoId}/blocks/${authorId}`));
}

// ---- Reads behind the admin queue -----------------------------------------------------

export interface StreetViewReportRow {
  id: string;
  targetType: 'streetview' | 'author';
  svId?: string;
  svTitle?: string;
  svOwnerId?: string;
  authorId?: string;
  /** null for a guest report — guests are never identified, only rate-limited. */
  reporterId: string | null;
  /** 1 means this report moved content by itself; 0 means it only landed in the queue. */
  reporterWeight: number;
  reason: ReportReason;
  details: string;
  status: 'open' | 'actioned' | 'dismissed';
  outcome?: string;
  autoHidden: boolean;
  priorReports: number;
  createdAtMillis: number | null;
  resolvedAtMillis: number | null;
}

function toReportRow(id: string, data: Record<string, unknown>): StreetViewReportRow {
  const ts = (v: unknown) => (v as Timestamp | undefined)?.toMillis?.() ?? null;
  return {
    id,
    targetType: data.targetType === 'author' ? 'author' : 'streetview',
    svId: typeof data.svId === 'string' ? data.svId : undefined,
    svTitle: typeof data.svTitle === 'string' ? data.svTitle : undefined,
    svOwnerId: typeof data.svOwnerId === 'string' ? data.svOwnerId : undefined,
    authorId: typeof data.authorId === 'string' ? data.authorId : undefined,
    reporterId: typeof data.reporterId === 'string' ? data.reporterId : null,
    reporterWeight: typeof data.reporterWeight === 'number' ? data.reporterWeight : 0,
    reason: (data.reason as ReportReason) ?? 'other',
    details: typeof data.details === 'string' ? data.details : '',
    status: (data.status as StreetViewReportRow['status']) ?? 'open',
    outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
    autoHidden: data.autoHidden === true,
    priorReports: typeof data.priorReports === 'number' ? data.priorReports : 0,
    createdAtMillis: ts(data.createdAt),
    resolvedAtMillis: ts(data.resolvedAt),
  };
}

/** Every report nobody has answered yet, newest first. */
export async function listOpenStreetViewReports(): Promise<StreetViewReportRow[]> {
  const snap = await getDocs(
    query(
      collection(firebaseDatabase, 'streetviewReports'),
      where('status', '==', 'open'),
      orderBy('createdAt', 'desc'),
    ),
  );
  return snap.docs.map((d) => toReportRow(d.id, d.data()));
}

/** The recent verdicts, so a wrong one can be found and undone. */
export async function listResolvedStreetViewReports(max = 100): Promise<StreetViewReportRow[]> {
  const snap = await getDocs(
    query(
      collection(firebaseDatabase, 'streetviewReports'),
      where('status', 'in', ['actioned', 'dismissed']),
      orderBy('createdAt', 'desc'),
      fsLimit(max),
    ),
  );
  return snap.docs.map((d) => toReportRow(d.id, d.data()));
}

export interface AutoHiddenRow {
  svId: string;
  title: string;
  ownerId: string;
  hiddenAtMillis: number | null;
}

/**
 * Panoramas the automation hid inside a window — the list the bulk restore works from.
 *
 * The point of this query is the aftermath of a report-bombing run: several gates make that
 * expensive to attempt (a daily cap per reporter, an hourly circuit breaker), but none makes it
 * impossible, and the recovery has to be one action rather than a hunt.
 */
export async function listAutoHiddenSince(cutoffMillis: number): Promise<AutoHiddenRow[]> {
  const snap = await getDocs(
    query(
      collection(firebaseDatabase, 'streetviews'),
      where('hiddenByReports', '==', true),
      where('hiddenAt', '>=', Timestamp.fromMillis(cutoffMillis)),
      orderBy('hiddenAt', 'desc'),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      svId: d.id,
      title: (data.displayName as string) || d.id,
      ownerId: (data.ownerId as string) ?? '',
      hiddenAtMillis: data.hiddenAt?.toMillis?.() ?? null,
    };
  });
}

/**
 * One panorama by id, for the `?sv=` deep link the notification e-mails and the app's share
 * link point at. Returns null when it is gone or the viewer may not see it — the rules answer
 * both cases the same way, and so does the page.
 */
export async function fetchStreetView(svId: string): Promise<StreetView | null> {
  try {
    const snap = await getDoc(doc(firebaseDatabase, `streetviews/${svId}`));
    if (!snap.exists()) return null;
    return toStreetView(snap);
  } catch (e) {
    console.warn('street view not readable', svId, e);
    return null;
  }
}

/** Display names for a set of account ids, for the admin queue. Missing accounts are skipped. */
export async function lookupUserNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(ids.filter(Boolean))].map(async (id) => {
      try {
        const snap = await getDoc(doc(firebaseDatabase, `users/${id}`));
        const data = snap.data();
        if (data) out.set(id, (data.displayName as string) || (data.email as string) || id);
      } catch {
        // A name is a nicety; the id is what the actions use.
      }
    }),
  );
  return out;
}
