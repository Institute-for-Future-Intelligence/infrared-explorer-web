/**
 * Street-view moderation: the parts that are pure decisions, kept out of index.ts so
 * they can be read (and reasoned about) without wading through Firestore plumbing.
 *
 * The whole scheme is documented in the app repo,
 * docs/proposals/street-view-ugc-governance.md. The short version: the map has no
 * pre-publication review, so a report has to act by itself — and anything that acts by
 * itself has to be impossible to weaponise. Every constant below exists because of a
 * specific way one person could otherwise blank the map.
 */

import * as crypto from 'crypto';

/** Report reasons, in the order the app lists them. */
export const REPORT_REASONS = ['privacy', 'inappropriate', 'wrong_location', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type ReportTargetType = 'streetview' | 'author';

/** Reports expire 12 months after they are filed — open ones included. */
export const REPORT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** Rolling rate-limit window for one reporter. */
export const REPORT_RATE_WINDOW_MS = 60 * 60 * 1000;
export const REPORT_RATE_MAX_SIGNED_IN = 10;
export const REPORT_RATE_MAX_GUEST = 5;

/**
 * How many auto-hides one reporter can cause in 24 hours. Their later reports still land
 * and still e-mail staff; they just stop moving content on their own. Without this a
 * single throwaway account hides 240 panoramas a day — more than the whole map.
 */
export const AUTO_HIDE_PER_REPORTER_24H = 3;
export const AUTO_HIDE_REPORTER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Circuit breaker. If this many auto-hides happen across the site within an hour,
 * something is wrong (a bombing run, or a bug) — stop hiding automatically until the
 * window rolls over. Reports keep landing and staff get told.
 */
export const AUTO_HIDE_GLOBAL_PER_HOUR = 10;
export const AUTO_HIDE_GLOBAL_WINDOW_MS = 60 * 60 * 1000;

/** An account younger than this with nothing of its own published carries no weight. */
export const NEW_ACCOUNT_MS = 7 * 24 * 60 * 60 * 1000;

/** Reports overturned by staff. At this many, the account never auto-hides anything again. */
export const FALSE_REPORT_LIMIT = 3;

/** At most one staff e-mail per target per hour; the rest are folded into the digest. */
export const REPORT_EMAIL_THROTTLE_MS = 60 * 60 * 1000;

export const MAX_REPORT_DETAILS = 500;

/**
 * Short digest of a reporter key, used in report document ids.
 *
 * The key itself (`u:<mongoId>` or `ip:<addr>`) must never appear in a path: a document id
 * survives field-level anonymisation, so deleting an account while its mongoId still spells
 * out the id of every report it filed would make the deletion promise false. The digest keeps
 * de-duplication working — same reporter, same target, same id — without being reversible to
 * an account or an address.
 */
export function reporterKeyDigest(reporterKey: string): string {
  return crypto.createHash('sha256').update(reporterKey).digest('hex').slice(0, 24);
}

/** Rate-limit bucket id for a reporter key. */
export function rateLimitKeyHash(reporterKey: string): string {
  return crypto.createHash('sha256').update(reporterKey).digest('hex').slice(0, 32);
}

/**
 * Deterministic report id, so a second report of the same thing by the same person
 * overwrites the first instead of counting twice. Guests get `null` — they are never
 * de-duplicated by identity (there is no trustworthy identity to de-duplicate on) and take
 * a random id instead.
 */
export function reportDocId(
  target: { targetType: ReportTargetType; svId?: string; authorId?: string },
  reporterKey: string | null,
): string | null {
  if (reporterKey == null) return null;
  const digest = reporterKeyDigest(reporterKey);
  return target.targetType === 'author' ? `author__${target.authorId}_${digest}` : `${target.svId}_${digest}`;
}

export interface ReportInput {
  targetType: ReportTargetType;
  svId?: string;
  authorId?: string;
  reason: ReportReason;
  details: string;
}

/**
 * Validate the callable's payload. Throws a plain Error whose message is safe to show;
 * index.ts turns it into an HttpsError.
 */
export function parseReportInput(data: unknown): ReportInput {
  const d = (data ?? {}) as Record<string, unknown>;
  const targetType = (d.targetType ?? 'streetview') as ReportTargetType;
  if (targetType !== 'streetview' && targetType !== 'author') {
    throw new Error('Unknown report target.');
  }
  const svId = typeof d.svId === 'string' ? d.svId.trim() : '';
  const authorId = typeof d.authorId === 'string' ? d.authorId.trim() : '';
  if (targetType === 'streetview' && !svId) throw new Error('svId is required.');
  if (targetType === 'author' && !authorId) throw new Error('authorId is required.');
  // A path segment, not a path: an id with a slash would address a different collection.
  if (svId.includes('/') || authorId.includes('/')) throw new Error('Bad id.');
  if (svId.length > 200 || authorId.length > 200) throw new Error('Bad id.');

  const reason = d.reason as ReportReason;
  if (!REPORT_REASONS.includes(reason)) throw new Error('Pick a reason for the report.');

  const details = typeof d.details === 'string' ? d.details.trim() : '';
  if (details.length > MAX_REPORT_DETAILS) throw new Error('Please shorten your description.');
  // "Something else" says nothing on its own; staff need a sentence to act on.
  if (reason === 'other' && !details) throw new Error('Please describe the problem.');

  return { targetType, svId: svId || undefined, authorId: authorId || undefined, reason, details };
}

export interface WeightInputs {
  /** Signed in AND email-verified — the security rules demand both of an owner, so we do too. */
  isVerifiedUser: boolean;
  falseReports: number;
  /** ms since epoch, or null when the profile doc carries no createdAt. */
  accountCreatedAtMs: number | null;
  /** Has this account published anything of its own? A stake in the map is the cheapest trust signal. */
  hasOwnUploads: boolean;
  nowMs: number;
}

/**
 * Does this reporter's word move content on its own?
 *
 * Weight 1 means one report hides a user's panorama outright — that is deliberate: the
 * response has to be visible in seconds, both for the person who was harmed and for an App
 * Review tester with ten minutes. Everything here is about who gets that power. A guest, an
 * unverified address, a brand-new account with nothing of its own, or someone staff have
 * already overruled three times can still report — the report lands, staff are told, and the
 * reporter stops seeing the panorama — but it does not move by itself.
 */
export function reporterWeight(input: WeightInputs): { weight: 0 | 1; note: string } {
  if (!input.isVerifiedUser) return { weight: 0, note: 'guest or unverified email' };
  if (input.falseReports >= FALSE_REPORT_LIMIT) return { weight: 0, note: 'reports repeatedly overturned' };
  const isNew = input.accountCreatedAtMs != null && input.nowMs - input.accountCreatedAtMs < NEW_ACCOUNT_MS;
  if (isNew && !input.hasOwnUploads) return { weight: 0, note: 'new account with no uploads' };
  return { weight: 1, note: 'established account' };
}

export interface AutoHideInputs {
  weight: 0 | 1;
  /** ownerId of the panorama. The legacy seed is staff-made, not UGC. */
  ownerId: string;
  /** Set once staff have looked at this panorama and kept it. */
  alreadyReviewedKept: boolean;
  alreadyHidden: boolean;
  /** Auto-hides this reporter has already caused inside the 24 h window. */
  reporterHides24h: number;
  /** Auto-hides across the whole site inside the current hour. */
  globalHidesThisHour: number;
}

/**
 * Should this report hide the panorama right now?
 *
 * Note what is NOT here: a count of previous reports. One weighted report is the threshold,
 * so the gates are all about the reporter and the target, never about accumulating strangers.
 */
export function shouldAutoHide(input: AutoHideInputs): { hide: boolean; note: string } {
  if (input.alreadyHidden) return { hide: false, note: 'already hidden' };
  if (input.weight !== 1) return { hide: false, note: 'reporter carries no weight' };
  // The ~238 seeded panoramas are our own published content, already looked at before they
  // went up. Treating them as UGC would let one account empty the map that exists today.
  if (input.ownerId === 'system') return { hide: false, note: 'legacy seed is not user content' };
  // Staff said keep. Re-hiding on the next report is how a restore/hide ping-pong starts,
  // and staff lose that game — the other side just makes another account.
  if (input.alreadyReviewedKept) return { hide: false, note: 'staff reviewed and kept it' };
  if (input.reporterHides24h >= AUTO_HIDE_PER_REPORTER_24H) {
    return { hide: false, note: 'reporter reached the daily auto-hide limit' };
  }
  if (input.globalHidesThisHour >= AUTO_HIDE_GLOBAL_PER_HOUR) {
    return { hide: false, note: 'site-wide auto-hide circuit breaker is open' };
  }
  return { hide: true, note: 'hidden' };
}

/** Human-readable reason for the staff e-mail and the admin list. */
export function reasonLabel(reason: ReportReason): string {
  switch (reason) {
    case 'privacy':
      return 'Privacy — a person, a licence plate or inside a home';
    case 'inappropriate':
      return 'Inappropriate or offensive';
    case 'wrong_location':
      return 'Wrong place on the map';
    case 'spam':
      return 'Spam or not a street view';
    default:
      return 'Something else';
  }
}

/**
 * Flatten a user-supplied string for an e-mail subject: no newlines (header injection),
 * bounded length.
 */
export function subjectSafe(text: string, max = 80): string {
  const flat = text.replace(/[\r\n]+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Is a rolling window still open? Shared by the rate limit, the hide budget and the breaker. */
export function withinWindow(windowStart: unknown, nowMs: number, windowMs: number): boolean {
  return typeof windowStart === 'number' && nowMs - windowStart < windowMs;
}
