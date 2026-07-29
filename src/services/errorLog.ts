import { Timestamp, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { firebaseDatabase } from './firebase';
import useCommonStore from '../stores/common';
import { VERSION } from '../utils/constants';

// Client crash reports, uploaded by the crash page (pages/errorPage.tsx) so the team can debug
// crashes that users would otherwise only describe as "it crashed". Docs carry `expireAt` for a
// Firestore TTL policy (~90 days) — same mechanism as viewRateLimits — so the collection
// self-purges instead of accumulating junk. Rules allow CREATE only (signed-out visitors
// included, since a crash can precede any auth state); reading is console/Admin-SDK only.

const RETENTION_DAYS = 90;

// Caps mirrored in firestore.rules — truncate client-side so an oversized stack degrades to a
// clipped report instead of a denied write.
const MAX_MESSAGE = 2000;
const MAX_STACK = 20000;

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

// One write per distinct error per page load: the crash UI can mount more than once for the same
// error (root boundary + router error element), and a report that logs twice is just junk.
const logged = new Set<string>();

export async function logErrorToFirebase(error: Error, componentStack?: string): Promise<void> {
  const message = clip(String(error?.message ?? error), MAX_MESSAGE);
  const stack = clip(error?.stack ?? '', MAX_STACK);
  const sig = `${message}\n${stack}`;
  if (logged.has(sig)) return;
  logged.add(sig);
  try {
    await addDoc(collection(firebaseDatabase, 'errorLogs'), {
      message,
      stack,
      componentStack: componentStack ? clip(componentStack, MAX_STACK) : null,
      url: clip(window.location.href, 2048),
      userAgent: clip(navigator.userAgent, 1024),
      appVersion: VERSION,
      env: import.meta.env.MODE,
      userId: useCommonStore.getState().user?.id ?? null,
      createdAt: serverTimestamp(),
      expireAt: Timestamp.fromMillis(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch (e) {
    // The crash page must never crash — a failed upload only loses the report. Un-mark the
    // signature so a later remount may retry (e.g. after the network comes back).
    logged.delete(sig);
    console.warn('Failed to upload crash report:', e);
  }
}

/** The plain-text details block shown on the crash page and copied by "Copy details". */
export function buildCrashDetails(error: Error, componentStack?: string): string {
  const lines = [
    `Infrared Explorer ${VERSION}`,
    `Time: ${new Date().toISOString()}`,
    `URL: ${window.location.href}`,
    `Browser: ${navigator.userAgent}`,
    '',
    `Error: ${String(error?.message ?? error)}`,
    '',
    'Stack trace:',
    error?.stack || '(no stack trace)',
  ];
  if (componentStack) lines.push('', 'Component stack:', componentStack.trim());
  return lines.join('\n');
}
