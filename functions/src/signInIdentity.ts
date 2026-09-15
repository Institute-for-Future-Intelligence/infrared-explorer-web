/**
 * Which profile a claimless sign-in becomes — the identity decision of onUserSignIn, kept out of
 * index.ts so it can be read and tested without the Firestore and Auth plumbing around it.
 *
 * What is at stake: onUserSignIn mints the `mongoId` custom claim, and that claim is the whole
 * identity. Every rules isOwner() and every callable's requireMongoId trust it, so whichever users
 * doc this function picks, the caller owns from then on — its experiments, its classes, its
 * deleteAccount. The old code picked `where('email', '==', token.email).limit(1)` and minted the
 * doc's `id` FIELD: an unverified email was taken as proof of a mailbox, a doc could name any other
 * profile in its `id`, whichever of several matching docs sorted first won, and a doc already bound
 * to another live login was handed over anyway. Each rule below closes one of those.
 *
 *  1. A verified email or nothing. Refused, not provisioned: a fresh profile for an unverified address
 *     would be stored under that address, and the address's real owner would then match it (or be
 *     split off from their migrated profile) — and a claim is useless to such an account anyway, since
 *     the Firestore rules' signedIn() already demands email_verified. Google and Apple always verify.
 *  2. The mongoId is the DOCUMENT id. No writer creates a doc whose `id` field differs from its doc id
 *     (onUserSignIn provisioning, scripts/migrationLib.mjs, the Phase 0 seeder all write both the same),
 *     so such a doc was edited by hand or by its owner through the pre-allowlist rules — the takeover
 *     itself. It is never bound, and when nothing else is eligible the sign-in is refused and logged.
 *  3. A doc bound to another auth uid is taken over only when that login is gone (user-not-found: the
 *     same person signing in again after their record was deleted) or has the same verified email.
 *     Otherwise it is someone else's, and the sign-in is refused rather than provisioned, so the person
 *     does not silently end up with an empty duplicate under the same address.
 *  4. The doc's `authUid` is checked against uidMap. Before the users allowlist rules an owner could
 *     rewrite `email` and `authUid` on their own doc: point `email` at somebody who has not signed up yet
 *     and delete `authUid` (or set it to a throwaway login they then delete), leaving a doc that looks
 *     like an unclaimed migrated profile. The rules freeze those fields from then on, but a doc edited
 *     before that keeps its forged values. uidMap is server-only, every server bind writes `authUid` and
 *     `uidMap/{authUid}` in the same call, and a uidMap row only goes away together with its doc — so a
 *     legitimate doc (a) with no authUid is named by no uidMap row, (b) with an authUid is named by that
 *     uid's row, and (c) is held by no other live login with a different email. A doc failing (a) or (b)
 *     was edited by a client and is never bound; one failing (c) still belongs to that login. The
 *     planting account's own row always names its doc, so the plant cannot pass as clean.
 *  5. Never an arbitrary pick between different kinds of profile. A doc already bound to this uid wins
 *     (the idempotent second call, before the client's token has refreshed). Otherwise exactly one
 *     eligible doc is bound. Several eligible docs that are ALL clean unclaimed profiles bind the lowest
 *     doc id, as the old limit(1) did, and are logged for a merge: Telelab keyed users by Google
 *     providerID, so the migration wrote more than one doc per address, and rule 4 guarantees no login
 *     has ever held any of them. Any other mix is a split profile for staff, refused and logged.
 * An existing claim is returned before any of this runs — only the Admin SDK can set one.
 */

/** Past this many docs sharing one email the lookup is not trusted to have seen them all. */
export const MAX_EMAIL_MATCHES = 5;

/** A users doc as the deleteAccount authUid fallback sees it. */
export interface ProfileRef {
  /** users/{docId} */
  docId: string;
  /** data().id — absent on some docs; must equal docId when present. */
  idField: unknown;
}

export interface EmailMatchedProfile extends ProfileRef {
  /** data().authUid — absent until the first sign-in binds the doc. */
  authUid: unknown;
  /** Every auth uid whose uidMap row names this doc (`uidMap where mongoId == docId`). Server-only data. */
  mappedUids: readonly string[];
}

/** The Auth record a uid names, looked up with the Admin SDK before deciding. */
export type PriorAuthRecord = { exists: false } | { exists: true; email: string | null; emailVerified: boolean };

export interface SignInIdentityInput {
  uid: string;
  /** token.email */
  email: unknown;
  /** token.email_verified */
  emailVerified: unknown;
  /** users docs whose email equals token.email, ordered by doc id. */
  matches: EmailMatchedProfile[];
  /** True when the query hit its limit (more than MAX_EMAIL_MATCHES docs). */
  truncated: boolean;
  /** Keyed by uid, for every uid that authUidsToLookUp returned. A missing entry fails closed. */
  priorAuth: ReadonlyMap<string, PriorAuthRecord>;
}

export type RefusalReason =
  | 'no-email'
  | 'email-unverified'
  | 'too-many-profiles'
  | 'ambiguous-profiles'
  | 'bound-to-other-account'
  | 'anomalous-profile';

export type ProfileClass =
  | 'self' // authUid === caller
  | 'unclaimed' // no authUid, and no other login's uidMap row names the doc
  | 'prior-deleted' // authUid names an auth record that no longer exists
  | 'prior-same-email' // authUid names a live record with the caller's email, verified
  | 'other-account' // authUid names a live record with a different or unverified email (or unknown)
  | 'held-by-other-account' // authUid is gone or same-email, but another login uidMap maps here is live and not
  | 'binding-stripped' // no authUid, yet another login's uidMap row names the doc: a client removed authUid
  | 'binding-not-on-record' // authUid names another uid with no uidMap row for the doc: no server bind wrote it
  | 'id-mismatch' // `id` field present and different from the doc id
  | 'bad-auth-uid'; // authUid present but not a non-empty string

export interface SkippedProfile {
  docId: string;
  class: ProfileClass;
}

type BindVia = 'self' | 'unclaimed' | 'prior-deleted' | 'prior-same-email';

export type SignInIdentityDecision =
  | { kind: 'provision' }
  | {
      kind: 'bind';
      mongoId: string;
      via: BindVia;
      /** The auth uid the doc named before this sign-in, when it was a different one. */
      previousAuthUid: string | null;
      /** Other clean unclaimed docs with the same email, left in place for a staff merge. */
      duplicates: string[];
      skipped: SkippedProfile[];
    }
  | {
      kind: 'refuse';
      reason: RefusalReason;
      code: 'failed-precondition';
      message: string;
      skipped: SkippedProfile[];
    };

const ELIGIBLE: ReadonlySet<ProfileClass> = new Set(['self', 'unclaimed', 'prior-deleted', 'prior-same-email']);

const UNVERIFIED_MESSAGE = 'Verify the email address of this account, then sign in again.';
/** Deliberately says nothing about which docs matched or who holds them. */
const UNRESOLVED_MESSAGE =
  'This sign-in could not be matched to a single Infrared Explorer account. Please contact us so we can link it.';
const PURGE_UNRESOLVED_MESSAGE =
  'This sign-in could not be matched to a single Infrared Explorer account, so nothing was deleted. ' +
  'Please contact us and we will delete it.';

function normalizedEmail(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

/**
 * The mongoId a users doc stands for: its doc id, provided any `id` field agrees. Null for a doc whose
 * `id` names something else — callers skip such docs instead of trusting either value.
 */
export function profileIdOf(docId: string, idField: unknown): string | null {
  if (idField === undefined || idField === null) return docId;
  return idField === docId ? docId : null;
}

/** The uids (bound authUids and uidMap logins) that need an Admin getUser() before decideSignInIdentity runs. */
export function authUidsToLookUp(uid: string, matches: EmailMatchedProfile[]): string[] {
  const out = new Set<string>();
  for (const m of matches) {
    if (typeof m.authUid === 'string' && m.authUid.length > 0 && m.authUid !== uid) out.add(m.authUid);
    for (const mapped of m.mappedUids) if (mapped.length > 0 && mapped !== uid) out.add(mapped);
  }
  return [...out];
}

export function classifyProfile(
  uid: string,
  callerEmail: string,
  match: EmailMatchedProfile,
  priorAuth: ReadonlyMap<string, PriorAuthRecord>,
): ProfileClass {
  if (profileIdOf(match.docId, match.idField) === null) return 'id-mismatch';
  const otherLogins = match.mappedUids.filter((u) => u !== uid);
  const authUid = match.authUid;
  if (authUid === undefined || authUid === null) return otherLogins.length > 0 ? 'binding-stripped' : 'unclaimed';
  if (typeof authUid !== 'string' || authUid.length === 0) return 'bad-auth-uid';
  if (authUid === uid) return 'self';
  if (!otherLogins.includes(authUid)) return 'binding-not-on-record';

  const login = (u: string): 'gone' | 'same-email' | 'other' => {
    const prior = priorAuth.get(u);
    if (!prior) return 'other'; // not looked up: fail closed
    if (!prior.exists) return 'gone';
    return prior.emailVerified && normalizedEmail(prior.email) === callerEmail ? 'same-email' : 'other';
  };
  const bound = login(authUid);
  if (bound === 'other') return 'other-account';
  if (otherLogins.some((u) => u !== authUid && login(u) === 'other')) return 'held-by-other-account';
  return bound === 'gone' ? 'prior-deleted' : 'prior-same-email';
}

export function decideSignInIdentity(input: SignInIdentityInput): SignInIdentityDecision {
  const email = normalizedEmail(input.email);
  if (email === null) {
    return {
      kind: 'refuse',
      reason: 'no-email',
      code: 'failed-precondition',
      message: UNVERIFIED_MESSAGE,
      skipped: [],
    };
  }
  if (input.emailVerified !== true) {
    return {
      kind: 'refuse',
      reason: 'email-unverified',
      code: 'failed-precondition',
      message: UNVERIFIED_MESSAGE,
      skipped: [],
    };
  }

  const classified = input.matches.map((m) => ({
    match: m,
    cls: classifyProfile(input.uid, email, m, input.priorAuth),
  }));
  const skipped: SkippedProfile[] = classified
    .filter((c) => !ELIGIBLE.has(c.cls))
    .map((c) => ({ docId: c.match.docId, class: c.cls }));
  const refuse = (reason: RefusalReason): SignInIdentityDecision => ({
    kind: 'refuse',
    reason,
    code: 'failed-precondition',
    message: UNRESOLVED_MESSAGE,
    skipped,
  });

  if (input.truncated || input.matches.length > MAX_EMAIL_MATCHES) return refuse('too-many-profiles');
  if (input.matches.length === 0) return { kind: 'provision' };

  const bind = (c: (typeof classified)[number], duplicates: string[] = []): SignInIdentityDecision => ({
    kind: 'bind',
    mongoId: c.match.docId,
    via: c.cls as BindVia,
    previousAuthUid:
      typeof c.match.authUid === 'string' && c.match.authUid.length > 0 && c.match.authUid !== input.uid
        ? c.match.authUid
        : null,
    duplicates,
    skipped,
  });

  // Already bound to this login: the same answer as last time, whatever else shares the address.
  const self = classified.filter((c) => c.cls === 'self');
  if (self.length === 1) return bind(self[0]);
  if (self.length > 1) return refuse('ambiguous-profiles');

  const eligible = classified.filter((c) => ELIGIBLE.has(c.cls));
  if (eligible.length === 1) return bind(eligible[0]);
  if (eligible.length > 1) {
    // Only clean unclaimed profiles (no authUid, no uidMap row, id consistent) are the address's own
    // migration duplicates. Take the lowest doc id, which is what limit(1) on this query always returned.
    if (!eligible.every((c) => c.cls === 'unclaimed')) return refuse('ambiguous-profiles');
    const ids = eligible.map((c) => c.match.docId).sort();
    const lowest = eligible.find((c) => c.match.docId === ids[0])!;
    return bind(lowest, ids.slice(1));
  }

  // Something matched this address, but none of it is this caller's to take. Provisioning here would
  // leave two profiles under one email (or hand a planted doc's owner a fresh start), so stop instead.
  return refuse(
    skipped.some((s) => s.class === 'other-account' || s.class === 'held-by-other-account')
      ? 'bound-to-other-account'
      : 'anomalous-profile',
  );
}

/**
 * deleteAccount's fallback when the caller has neither a claim nor a uidMap row: the users doc bound to
 * this authUid. authUid is written only by onUserSignIn, so every such doc is the caller's; a doc whose
 * `id` field disagrees with its doc id is skipped (and reported) rather than purged under either name.
 * Several bound docs (two concurrent first sign-ins) resolve to the lowest doc id, so the purge still
 * runs; the stray-doc sweep in deleteAccount removes the other docs.
 */
export function purgeProfileByAuthUid(docs: ProfileRef[]): { mongoId: string | null; anomalies: string[] } {
  const anomalies = docs.filter((d) => profileIdOf(d.docId, d.idField) === null).map((d) => d.docId);
  const consistent = docs
    .filter((d) => profileIdOf(d.docId, d.idField) !== null)
    .map((d) => d.docId)
    .sort();
  return { mongoId: consistent[0] ?? null, anomalies };
}

export type PurgeByEmailResult =
  | { kind: 'none'; skipped: SkippedProfile[] }
  | { kind: 'profile'; mongoId: string; duplicates: string[]; skipped: SkippedProfile[] }
  | { kind: 'refuse'; reason: RefusalReason; message: string; skipped: SkippedProfile[] };

/**
 * deleteAccount's last resort, for a caller with no claim, no uidMap row and no bound doc: exactly the
 * profile onUserSignIn would bind this caller to, from the same input — so the purge and the sign-in
 * cannot disagree about whose data it is, and an unverified email (never even looked up) resolves nothing.
 *  - bind -> purge that profile.
 *  - provision -> nothing to purge; only the login goes.
 *  - refused because every match is another login's or was tampered with -> none of it is this caller's:
 *    nothing is purged and only the login goes (so a planted doc cannot block anybody's deletion).
 *  - refused as ambiguous or too many -> the caller's own profile is probably among them but cannot be
 *    picked. Refuse the deletion rather than delete the login and silently keep the data.
 */
export function purgeProfileByEmail(input: SignInIdentityInput): PurgeByEmailResult {
  const decision = decideSignInIdentity(input);
  if (decision.kind === 'provision') return { kind: 'none', skipped: [] };
  if (decision.kind === 'bind') {
    return { kind: 'profile', mongoId: decision.mongoId, duplicates: decision.duplicates, skipped: decision.skipped };
  }
  if (decision.reason === 'ambiguous-profiles' || decision.reason === 'too-many-profiles') {
    return { kind: 'refuse', reason: decision.reason, message: PURGE_UNRESOLVED_MESSAGE, skipped: decision.skipped };
  }
  return { kind: 'none', skipped: decision.skipped };
}
