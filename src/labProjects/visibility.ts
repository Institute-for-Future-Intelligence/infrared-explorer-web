/*
 * Shim for the app's src/lib/visibility.ts, which the synced core/types.ts imports the `Visibility` type
 * from: the three tiers every shared thing has — Private / Link Only (stored 'unlisted') / Public. The
 * app's file also carries its i18n keys and the Share panel's hints, which the website has its own of
 * (components/visibilityControl.tsx); only the type is wanted here.
 */
export type Visibility = 'private' | 'unlisted' | 'public';
