# Sign-in providers (Google + Apple) and account linking

How the web signs people in, what has to exist in the Apple / Firebase consoles for the Apple
half to work, and how one account carries both methods. The capture app's side of the same
story is `infrared-explorer-app/docs/ios-signin-setup.md`.

## What the code does

- `src/services/auth.ts` owns every provider call. `signIn()` opens the chooser
  (`src/components/signInDialog.tsx`, mounted once in the Layout); `signInWithProvider()` runs
  the popup for Google (`GoogleAuthProvider`) or Apple (`OAuthProvider('apple.com')`, scopes
  `email` + `name`). Everything downstream (mongoId claim, store user, rules) is provider-agnostic.
- **Linking.** Settings › *Sign-in methods* lists both providers with Link / Unlink
  (`linkWithPopup` / `unlink`). The last method can never be removed. Linking keeps the uid, so the
  `mongoId` claim, the user docs and every ownership check are untouched — the account simply has
  one more way in, and the capture app honours it too (Apple on the iPhone, Google on Android, same
  account).
- **Email collision.** The project is set to *Link accounts that use the same email* (see below),
  under which Firebase itself links a second provider onto the existing account whenever the new
  provider asserts a **verified** email — which both Google and Apple do, so the usual same-address
  case needs no help from us. The client still handles
  `auth/account-exists-with-different-credential` for the cases Firebase refuses to link on its
  own: the dialog explains which method the existing account uses, and choosing it signs the user
  in and `linkWithCredential`s the rejected credential, so the collision ends as a linked account
  rather than a dead end.
- **Re-authentication** for account deletion (`reauthenticateCurrentUser`) goes through Apple
  whenever Apple is linked, else Google — Apple's popup is the only source of the fresh Apple
  access token the next bullet needs.
- **Grant revocation on deletion.** Apple requires an app that offers Sign in with Apple to revoke
  the user's grant when the account is deleted (TN3194 / App Store Review 5.1.1(v)). The capture
  app does it on-device (`revokeToken` with the native sheet's authorization code); the web page
  cannot (Firebase consumed the code inside its popup), so it passes Apple's access token to the
  `deleteAccount` callable, which signs a client_secret with the team's .p8
  (`APPLE_SIGNIN_PRIVATE_KEY` in Secret Manager) and calls Apple's `/auth/revoke` before anything
  is destroyed — `functions/src/appleRevoke.ts`. The callable also accepts a native
  `authorizationCode` (exchanged first, and refused if it names another Apple user), so the app
  can move to server-side revocation later without a contract change. A rejected client_secret
  aborts the deletion with nothing removed (that is our misconfiguration to fix); a stale token
  is logged and the purge proceeds. The response's `appleRevocation` field says which happened.
- Apple specifics the UI must not assume away: the email may be a private relay address
  (`…@privaterelay.appleid.com`), and the name arrives on the **first** authorization only, so
  `displayName` can be null — Settings lets the user pick a nickname.

## One-time console setup for Apple on the web

Native iOS Sign in with Apple needed none of this; the web (and Android) flow does.

1. **Apple Developer → Identifiers → Services IDs**: create one (e.g.
   `org.intofuture.infraredexplorer.web`), enable *Sign in with Apple*, and configure it with
   **Primary App ID = `org.intofuture.infraredexplorer.ios`** — that is what makes Apple return
   the same user identifier (`sub`) for the app and the website, so Firebase lands both on one uid
   and the relay email stays the same. Domains: `ie.intofuture.org`,
   `infrared-explorer.firebaseapp.com`. Return URL:
   `https://infrared-explorer.firebaseapp.com/__/auth/handler`.
2. **Apple Developer → Keys**: create a key with *Sign in with Apple* enabled (grouped under the
   same primary App ID), download the `.p8` once, note the Key ID. Team ID is `BW5V78V378`.
3. **Firebase console → Authentication → Sign-in method → Apple**: fill in the Services ID, Team
   ID, Key ID and paste the private key. Leave the OAuth code flow section's redirect as shown.
4. **Firebase console → Authentication → Settings → User account linking** must stay on
   **"Link accounts that use the same email"** (the default; older consoles called it *Prevent
   creation of multiple accounts with the same email address*). The other option, *Create multiple
   accounts for each identity provider*, would give one person a separate uid — and therefore a
   separate mongoId and a separate set of experiments — per provider, which is exactly the split
   this feature exists to prevent.
5. If the site ever emails users, register the sending domain under Apple's *Sign in with Apple
   → Email Communication* so mail to private relay addresses is forwarded.

Until step 3 is done the Apple button fails with `auth/operation-not-allowed`, which the dialog
reports as "Sign in with Apple isn't enabled for this site yet".

## Known limits

- **No account merging.** Someone who already has a Google-created web account *and* an
  Apple-created app account (hidden email, so no collision ever fired) owns two identities.
  Linking Apple onto the Google one fails with `auth/credential-already-in-use`; the message says
  so and tells them to keep using whichever account holds their data. Merging would mean
  re-owning experiments, recordings and classroom records server-side — a purge-style job, not
  a client feature.
- `signInWithPopup` runs on `infrared-explorer.firebaseapp.com` while the site is
  `ie.intofuture.org`; Safari's storage partitioning can break that cross-site popup. It was
  already true for Google, but Apple users are disproportionately Safari users — if it bites,
  the fix is serving `/__/auth/*` from the site's own domain (authDomain = `ie.intofuture.org`).
- The capture app's own on-device revocation goes through Firebase (`revokeToken`), which only
  works now that the console's OAuth code flow configuration is filled; its result is a console
  warning at most. Switching the app to send the authorization code to the callable instead
  would make the outcome visible in the server log — see the revocation bullet above.
