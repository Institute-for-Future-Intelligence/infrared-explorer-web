/*
 * Default display name for a user the identity provider named for us — the server half.
 *
 * onUserSignIn provisions brand-new users, and a Sign in with Apple token usually carries no
 * `name` at all (Apple releases it on the first authorization only) plus, under "Hide My Email", a
 * random @privaterelay.appleid.com address. Provisioning such a user with `displayName: null` left
 * every page falling back to that relay address; deriving a name here means the account has a
 * usable one from its very first write, which is what the `author` string on their experiments and
 * the name on their comments copy.
 *
 * MIRRORED in src/utils/displayName.ts — the client derives the same default before its profile
 * read lands, and src/utils/displayName.test.ts asserts the two builds stay in step.
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
 * otherwise from `seed` (the user's stable identity key — the mongoId) so two nameless users don't
 * collide. Never empty, and always short enough for the usersPublic 120-char rule.
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
