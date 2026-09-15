/**
 * Flagging an AI lab report (Google Play's AI-Generated Content policy: a user must be able to report
 * offensive AI output from inside the app). App repo docs/proposals/ai-open-access.md §3.6.
 *
 * Deliberately not the street-view `reportStreetView` callable: that one refuses a report on your own
 * content — and the owner is the report's main reader — and a qualifying report there moves the whole
 * experiment to the trash, which is far too heavy for a paragraph of machine prose. A flag here only
 * lands in aiReportFlags/ and emails staff (coalesced, see planAiFlagMail). Nothing is hidden automatically and the owner is not told;
 * staff take a report down by deleting the aiReport* fields (as clearLabReport does).
 *
 * The decisions are plain functions with tests; aiReportFlagFunctions() wires them to Firestore. It takes
 * index.ts's own db, sign-in check and mailer, so this file needs no copy of any of them.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import type { defineSecret } from 'firebase-functions/params';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { REPORT_EMAIL_THROTTLE_MS, rateLimitKeyHash, reporterKeyDigest, subjectSafe, withinWindow } from './moderation';

export const AI_FLAG_REASONS = ['inappropriate', 'inaccurate', 'other'] as const;
export type AiFlagReason = (typeof AI_FLAG_REASONS)[number];

export const AI_FLAG_DETAILS_MAX = 500;
/** How much of the report the flag keeps, so staff can still read what was flagged after a regenerate. */
export const AI_FLAG_REPORT_TEXT_MAX = 20_000;
/** How much of it the staff email quotes. */
export const AI_FLAG_EMAIL_EXCERPT = 1000;
/** Flags expire 12 months after they are filed (privacy policy §1.8), open ones included. */
export const AI_FLAG_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** One account's flags per rolling hour, in the reporting buckets (reportRateLimits) under its own key. */
export const AI_FLAG_RATE_MAX = 10;
export const AI_FLAG_RATE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Flag emails in all, per hour. One account's ten flags an hour is no brake on a handful of accounts, and
 * every regenerate is a new version to flag; without a total they could spend the SMTP account's daily
 * quota, which contact-form and street-view report mail share. A held flag is still in the queue.
 */
export const AI_FLAG_MAIL_PER_HOUR = 10;
/** moderationEmailThrottle ids: one per experiment, and one for the hourly total ("-" never follows the "_"). */
export const AI_FLAG_MAIL_TOTAL_ID = 'aiflag-all';
export function aiFlagMailThrottleId(expId: string): string {
  return `aiflag_${expId}`;
}

export interface AiFlagInput {
  expId: string;
  reason: AiFlagReason;
  details: string;
}

/** Validate the callable's payload. Throws a plain Error whose message is safe to show. */
export function parseAiFlagInput(data: unknown): AiFlagInput {
  const d = (data ?? {}) as Record<string, unknown>;
  const expId = typeof d.expId === 'string' ? d.expId.trim() : '';
  if (!expId) throw new Error('Missing expId.');
  // A path segment, not a path: an id with a slash would address a different collection.
  if (expId.includes('/') || expId.length > 200) throw new Error('Bad id.');

  const reason = d.reason as AiFlagReason;
  if (!AI_FLAG_REASONS.includes(reason)) throw new Error('Pick a reason for the report.');

  const details = typeof d.details === 'string' ? d.details.trim() : '';
  if (details.length > AI_FLAG_DETAILS_MAX) throw new Error('Please shorten your description.');
  // "Something else" says nothing on its own; staff need a sentence to act on.
  if (reason === 'other' && !details) throw new Error('Please describe the problem.');
  return { expId, reason, details };
}

export function aiFlagReasonLabel(reason: AiFlagReason): string {
  switch (reason) {
    case 'inappropriate':
      return 'Inappropriate or offensive';
    case 'inaccurate':
      return 'Inaccurate or misleading';
    default:
      return 'Something else';
  }
}

/** The reporting bucket's key. Prefixed, so flags and street-view reports never share a budget. */
export function aiFlagRateKey(mongoId: string): string {
  return `ai:${mongoId}`;
}

/** Timestamp | Date | ms → ms; 0 when there is none (an old report written before aiReportAt existed). */
export function reportAtMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const maybe = value as { toMillis?: unknown } | null;
  if (maybe && typeof maybe.toMillis === 'function') return Number((maybe.toMillis as () => number)()) || 0;
  return 0;
}

/**
 * One flag per person per VERSION of a report: a second flag of the same text by the same account replaces
 * the first, while a flag after the report was regenerated is a new document about new text. The account
 * appears only as a digest (as in streetviewReports ids), so the id alone does not name who filed it.
 */
export function aiFlagDocId(expId: string, reporterId: string, reportAtMs: number): string {
  return `${expId}__${reporterKeyDigest(`u:${reporterId}`)}__${reportAtMs}`;
}

/**
 * Who may flag: anyone who can read the experiment, by the same rule firestore.rules applies to
 * experiments/{expId} — public and unlisted for everyone, anything else for its owner. A private
 * experiment answers a stranger exactly as a missing one does, so the callable cannot be used to learn
 * which ids exist.
 */
export function canFlagExperiment(exp: Record<string, unknown> | undefined, mongoId: string): boolean {
  if (!exp) return false;
  return exp.visibility === 'public' || exp.visibility === 'unlisted' || exp.ownerId === mongoId;
}

export function hasAiReport(exp: Record<string, unknown>): boolean {
  return typeof exp.aiReport === 'string' && exp.aiReport.trim() !== '';
}

/** A new flag document. Everything staff need is snapshotted, so it still makes sense after the report or
 *  the experiment is gone. */
export function buildAiFlagDoc(opts: {
  expId: string;
  exp: Record<string, unknown>;
  input: AiFlagInput;
  reporterId: string;
  nowMs: number;
}): Record<string, unknown> {
  const { expId, exp, input, reporterId, nowMs } = opts;
  const now = Timestamp.fromMillis(nowMs);
  return {
    expId,
    expTitle: String(exp.displayName ?? expId),
    expOwnerId: String(exp.ownerId ?? ''),
    reportModel: typeof exp.aiReportModel === 'string' ? exp.aiReportModel : null,
    reportAt: exp.aiReportAt ?? null,
    reportText: String(exp.aiReport ?? '').slice(0, AI_FLAG_REPORT_TEXT_MAX),
    reason: input.reason,
    details: input.details,
    reporterId,
    reporterIsOwner: exp.ownerId === reporterId,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    expireAt: Timestamp.fromMillis(nowMs + AI_FLAG_RETENTION_MS),
  };
}

/** The same person flagging the same report again: their latest words replace the earlier ones; when it
 *  was first filed, and anything staff have done with it, stay. */
export function aiFlagRefileUpdate(input: AiFlagInput, nowMs: number): Record<string, unknown> {
  return { reason: input.reason, details: input.details, updatedAt: Timestamp.fromMillis(nowMs) };
}

/** The reporting bucket after one more flag, or null when the hour's flags are spent. */
export function planAiFlagRateCharge(
  bucket: { count?: unknown; windowStart?: unknown } | undefined,
  nowMs: number,
): { count: number; windowStart: number; expireAt: Timestamp } | null {
  const inWindow = withinWindow(bucket?.windowStart, nowMs, AI_FLAG_RATE_WINDOW_MS);
  const count = inWindow && typeof bucket?.count === 'number' ? bucket.count : 0;
  if (count >= AI_FLAG_RATE_MAX) return null;
  return {
    count: count + 1,
    windowStart: inWindow ? (bucket!.windowStart as number) : nowMs,
    // reportRateLimits carries a TTL on expireAt; this bucket only has to outlive its hour.
    expireAt: Timestamp.fromMillis(nowMs + 2 * AI_FLAG_RATE_WINDOW_MS),
  };
}

type MailBucket = { windowStart?: unknown; sent?: unknown; suppressed?: unknown } | undefined;

export interface AiFlagMailPlan {
  send: boolean;
  /** Flags on this experiment that were not emailed since the last email about it. */
  heldForExperiment: number;
  /** Flags the hourly total held back before this email opened a new hour. */
  heldByCap: number;
  /** Merged into moderationEmailThrottle/aiflag_{expId}. */
  experimentWrite: Record<string, unknown>;
  /** Merged into moderationEmailThrottle/aiflag-all; null when the total is not involved. */
  totalWrite: Record<string, unknown> | null;
}

/**
 * Whether a new flag emails staff — street-view report mail's rule (one per target per hour) plus a total
 * across all experiments. A flag held by the total leaves its experiment's hour unopened, so the next flag
 * there can still mail once the total clears. Counts of what was held ride along on the next email that
 * does go out; they reset only when one does.
 */
export function planAiFlagMail(experiment: MailBucket, total: MailBucket, nowMs: number): AiFlagMailPlan {
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  // moderationEmailThrottle carries a TTL on expireAt; a bucket only has to outlive its hour.
  const expireAt = Timestamp.fromMillis(nowMs + 2 * REPORT_EMAIL_THROTTLE_MS);
  const heldForExperiment = count(experiment?.suppressed);
  const held = { suppressed: heldForExperiment + 1, expireAt };

  if (withinWindow(experiment?.windowStart, nowMs, REPORT_EMAIL_THROTTLE_MS)) {
    return { send: false, heldForExperiment, heldByCap: 0, experimentWrite: held, totalWrite: null };
  }
  const totalOpen = withinWindow(total?.windowStart, nowMs, REPORT_EMAIL_THROTTLE_MS);
  const sent = totalOpen ? count(total?.sent) : 0;
  if (sent >= AI_FLAG_MAIL_PER_HOUR) {
    return {
      send: false,
      heldForExperiment,
      heldByCap: 0,
      experimentWrite: held,
      totalWrite: { suppressed: count(total?.suppressed) + 1, expireAt },
    };
  }
  return {
    send: true,
    heldForExperiment,
    heldByCap: totalOpen ? 0 : count(total?.suppressed),
    experimentWrite: { windowStart: nowMs, suppressed: 0, expireAt },
    totalWrite: totalOpen ? { sent: sent + 1, expireAt } : { windowStart: nowMs, sent: 1, suppressed: 0, expireAt },
  };
}

/** The staff email for a new flag, with what the throttle held back since the last one. */
export function aiFlagEmail(
  id: string,
  flag: Record<string, unknown>,
  projectId: string,
  held: { experiment: number; cap: number } = { experiment: 0, cap: 0 },
): { subject: string; text: string } {
  const title = String(flag.expTitle ?? flag.expId ?? '');
  const reason = AI_FLAG_REASONS.includes(flag.reason as AiFlagReason)
    ? aiFlagReasonLabel(flag.reason as AiFlagReason)
    : String(flag.reason ?? '');
  const text = String(flag.reportText ?? '');
  const excerpt = text.length > AI_FLAG_EMAIL_EXCERPT ? `${text.slice(0, AI_FLAG_EMAIL_EXCERPT)}…` : text;
  const docPath = `~2FaiReportFlags~2F${encodeURIComponent(id)}`;
  const flags = (n: number) => `${n} ${n === 1 ? 'flag' : 'flags'}`;
  const lines = [
    `An AI lab report was flagged on "${title}" (${String(flag.expId ?? '')}).`,
    '',
    `Reason: ${reason}`,
    `Details: ${String(flag.details ?? '') || '(none)'}`,
    `Filed by: ${flag.reporterIsOwner === true ? "the experiment's owner" : 'another viewer'}`,
    `Model: ${String(flag.reportModel ?? 'unknown')}`,
    '',
    `The report as flagged (first ${AI_FLAG_EMAIL_EXCERPT.toLocaleString('en-US')} characters):`,
    '',
    excerpt,
    '',
    `Open the experiment: https://ie.intofuture.org/experiments/${String(flag.expId ?? '')}`,
    `The flag in the console: https://console.firebase.google.com/project/${projectId}/firestore/databases/-default-/data/${docPath}`,
    '',
    held.experiment > 0 ? `Not emailed since the last email about this experiment: ${flags(held.experiment)}.` : null,
    held.cap > 0
      ? `Not emailed because more than ${AI_FLAG_MAIL_PER_HOUR} were due in an hour: ${flags(held.cap)}.`
      : null,
    `Only the first flag on an experiment each hour is emailed, and at most ${AI_FLAG_MAIL_PER_HOUR} flags an ` +
      'hour in all. The full queue is aiReportFlags where status == "open".',
    '',
    'To take the report down, delete the aiReport* fields on the experiment (the ones clearLabReport ' +
      'removes) and set this flag\'s status to "actioned"; otherwise set it to "dismissed".',
  ].filter((l): l is string => l != null);
  return { subject: `[AI report flagged] ${subjectSafe(title)}`, text: lines.join('\n') };
}

export interface AiReportFlagDeps {
  db: Firestore;
  /** index.ts's requireMongoId: the same errors for a signed-out or unprovisioned caller. */
  requireMongoId: (auth: { uid: string; token: Record<string, unknown> } | undefined) => string;
  /** index.ts's sendMail, which logs and never throws. */
  sendMail: (mail: { subject: string; text: string }, context: string) => Promise<boolean>;
  /** The SMTP secrets sendMail reads, bound to the trigger that sends. */
  mailSecrets: ReturnType<typeof defineSecret>[];
}

export function aiReportFlagFunctions(deps: AiReportFlagDeps) {
  const { db } = deps;

  /** Flag the AI report on an experiment the caller can read. Owners may flag their own. */
  const flagAiReport = onCall(async (request) => {
    const mongoId = deps.requireMongoId(request.auth);
    let input: AiFlagInput;
    try {
      input = parseAiFlagInput(request.data);
    } catch (e) {
      throw new HttpsError('invalid-argument', (e as Error).message);
    }

    const exp = (await db.doc(`experiments/${input.expId}`).get()).data();
    if (!exp || !canFlagExperiment(exp, mongoId)) {
      throw new HttpsError('not-found', 'That experiment no longer exists.');
    }
    if (!hasAiReport(exp)) throw new HttpsError('failed-precondition', 'There is no AI report to report.');

    const nowMs = Date.now();
    const limitRef = db.doc(`reportRateLimits/${rateLimitKeyHash(aiFlagRateKey(mongoId))}`);
    const flagRef = db.doc(`aiReportFlags/${aiFlagDocId(input.expId, mongoId, reportAtMillis(exp.aiReportAt))}`);
    await db.runTransaction(async (tx) => {
      const [limitSnap, flagSnap] = await Promise.all([tx.get(limitRef), tx.get(flagRef)]);
      // Charged for a re-flag too: repeating the same flag is exactly what the limit is for.
      const bucket = planAiFlagRateCharge(limitSnap.data(), nowMs);
      if (!bucket) throw new HttpsError('resource-exhausted', 'Too many reports just now. Please try again later.');
      tx.set(limitRef, bucket, { merge: true });
      if (flagSnap.exists) {
        tx.update(flagRef, aiFlagRefileUpdate(input, nowMs));
      } else {
        tx.set(flagRef, buildAiFlagDoc({ expId: input.expId, exp, input, reporterId: mongoId, nowMs }));
      }
    });
    return { ok: true };
  });

  /**
   * Tell staff. Created only — a re-flag updates the document and does not mail again. Throttled by
   * planAiFlagMail in moderationEmailThrottle (server-only, TTL on expireAt), as street-view report mail is.
   */
  const onAiReportFlagCreated = onDocumentCreated(
    { document: 'aiReportFlags/{id}', secrets: deps.mailSecrets },
    async (event) => {
      const flag = event.data?.data();
      if (!flag) return;
      try {
        const nowMs = Date.now();
        const experimentRef = db.doc(
          `moderationEmailThrottle/${aiFlagMailThrottleId(String(flag.expId ?? 'unknown'))}`,
        );
        const totalRef = db.doc(`moderationEmailThrottle/${AI_FLAG_MAIL_TOTAL_ID}`);
        const plan = await db.runTransaction(async (tx) => {
          const [experimentSnap, totalSnap] = await Promise.all([tx.get(experimentRef), tx.get(totalRef)]);
          const next = planAiFlagMail(experimentSnap.data(), totalSnap.data(), nowMs);
          tx.set(experimentRef, next.experimentWrite, { merge: true });
          if (next.totalWrite) tx.set(totalRef, next.totalWrite, { merge: true });
          return next;
        });
        if (!plan.send) {
          console.log(`[aiReportFlags] staff email for ${event.params.id} held by the throttle`);
          return;
        }
        const projectId = process.env.GCLOUD_PROJECT || 'infrared-explorer';
        await deps.sendMail(
          aiFlagEmail(event.params.id, flag, projectId, { experiment: plan.heldForExperiment, cap: plan.heldByCap }),
          `AI report flag ${event.params.id}`,
        );
      } catch (err) {
        // The flag is stored either way; a throw here would only make the trigger retry into the same failure.
        // A failed throttle transaction sends nothing, the safe side of a cap on mail.
        console.error(`[aiReportFlags] staff email for ${event.params.id} failed`, err);
      }
    },
  );

  return { flagAiReport, onAiReportFlagCreated };
}
