/*
 * The reports a class page last read (fetchClassReports), so the report page opened from it
 * paints without a second round trip; a cold open of a report page reads the list itself.
 */

import type { ClassReport } from './types';

const byClass = new Map<string, ClassReport[]>();

export function cachedReports(classId: string): ClassReport[] | null {
  return byClass.get(classId) ?? null;
}

export function rememberReports(classId: string, reports: ClassReport[]) {
  byClass.set(classId, reports);
}

export function forgetReports(classId: string) {
  byClass.delete(classId);
}
