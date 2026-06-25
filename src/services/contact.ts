import { httpsCallable } from 'firebase/functions';
import { firebaseFunctions } from './firebase';

/**
 * Submit a contact-us message. Goes through the submitContactMessage callable, which rate-limits
 * per IP and writes the message server-side (clients can no longer write the contactMessages
 * collection directly).
 */
export async function submitContact(name: string, email: string, message: string): Promise<void> {
  const fn = httpsCallable<{ name: string; email: string; message: string }, { ok: boolean }>(
    firebaseFunctions,
    'submitContactMessage',
  );
  await fn({ name, email, message });
}
