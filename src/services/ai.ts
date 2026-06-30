import { httpsCallable } from 'firebase/functions';
import { firebaseFunctions } from './firebase';

/**
 * Generate a physics-grounded lab-report DRAFT for an experiment via the generateLabReport callable.
 * The function reads the experiment's real thermal data server-side (the Claude key never reaches the
 * client) and returns Markdown text the caller pre-fills into the editable description box. Currently
 * supports recording-based experiments; throws (failed-precondition) for video showcases.
 */
export async function generateLabReport(expId: string): Promise<string> {
  const fn = httpsCallable<{ expId: string }, { report: string }>(firebaseFunctions, 'generateLabReport');
  const res = await fn({ expId });
  return res.data.report;
}
