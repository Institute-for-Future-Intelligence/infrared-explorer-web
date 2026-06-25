import { User } from '../types';

// Internal IFI employees are identified purely by their sign-in email domain — there is no
// role/claim system in this app (roles were deferred in the telelab migration). Anyone signed
// in with an @intofuture.org Google account is treated as staff and sees the Admin menu.
// The Firestore rules enforce the same check server-side (see firestore.rules `isStaff()`), so
// this is only a UI gate — flipping it client-side grants no data access.
export const STAFF_EMAIL_DOMAIN = '@intofuture.org';

export const isStaff = (user: User | null | undefined): boolean =>
  !!user?.email && user.email.toLowerCase().endsWith(STAFF_EMAIL_DOMAIN);
