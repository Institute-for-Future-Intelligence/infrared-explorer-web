/*
 * The name a user wears when neither the identity provider nor Settings gave us one.
 *
 * Sign in with Apple hands the full name over on the FIRST authorization only, and only if the
 * user agrees to share it — so an Apple account normally reaches us with no `name` at all and,
 * when "Hide My Email" is on, a random @privaterelay.appleid.com address. Falling back to the
 * email (what every identity surface used to do) then put a 40-character relay address where a
 * name belongs: it overflowed the settings sidebar and told the reader nothing.
 *
 * So: derive a name instead. A real address still yields something human ("john.doe@…" -> "John
 * Doe"); a relay address is treated as no address at all and the user becomes "Explorer 7F3A",
 * distinct enough to tell two of them apart and obviously editable in Settings › Display name.
 * The auth listener persists whatever comes out of here on first sign-in, so the same name reaches
 * comments and the denormalized `author` on the user's experiments.
 *
 * MIRRORED in functions/src/index.ts (onUserSignIn), which provisions new users with the same
 * default — keep the two in step, or a name minted server-side would differ from the one the
 * client shows.
 */

const APPLE_RELAY_DOMAIN = '@privaterelay.appleid.com';

/** Apple's "Hide My Email" relay address: a random local part, never a name and never reusable. */
export function isPrivateRelayEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(APPLE_RELAY_DOMAIN);
}

/** "john.doe" / "john_doe+tag" -> "John Doe". Only the first letter is touched: "McKay" stays "McKay". */
function humanizeLocalPart(localPart: string): string | null {
  const local = localPart.split('+')[0]; // a gmail-style +tag is routing, not part of anyone's name
  const words = local.split(/[._-]+/).filter((w) => w.length > 0);
  // Needs at least one letter to read as a name — "12345@…" is a number, not a person.
  if (words.length === 0 || !/[a-z]/i.test(local)) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * A display name for a user who has none, derived from the email when that email is a real one and
 * otherwise from `seed` (the caller's stable identity key — the mongoId) so two nameless users
 * don't collide. Never empty, and always short enough for the usersPublic 120-char rule.
 */
export function defaultDisplayName(email: string | null | undefined, seed: string): string {
  if (email && !isPrivateRelayEmail(email) && email.includes('@')) {
    const name = humanizeLocalPart(email.slice(0, email.indexOf('@')));
    if (name) return name.slice(0, 120);
  }
  const suffix = seed
    .replace(/[^a-z0-9]/gi, '')
    .slice(-4)
    .toUpperCase();
  return suffix ? `Explorer ${suffix}` : 'Explorer';
}

/**
 * What to show for the signed-in user, in order: the nickname they saved, the name their provider
 * gave, then the derived default. Use this everywhere an identity is rendered — no page should
 * fall back to the raw email again.
 */
export function userDisplayName(user: { displayName?: string | null; email?: string | null; id: string }): string {
  return user.displayName?.trim() || defaultDisplayName(user.email, user.id);
}
