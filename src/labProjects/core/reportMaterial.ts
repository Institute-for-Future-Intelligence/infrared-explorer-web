/*
 * Whether the AI has anything to write a project's report from: a plan, a
 * capture sent to it, or something said in the conversation. Until then
 * Generate Report stays off (a report asked of an empty project is made up).
 * A capture still waiting beside the message box has not reached the AI, and
 * a Generate Report request is not something said. The server refuses the
 * request by the same test (functions/src/turn.ts hasReportMaterial).
 */

import type {ProjectBundle} from './types';

export function hasReportMaterial(b: ProjectBundle | null): boolean {
  if (!b) {
    return false;
  }
  return (
    b.project.plan != null ||
    b.project.takes.some(t => t.announced) ||
    b.turns.some(t => (t.role === 'user' && t.request == null) || t.role === 'event')
  );
}
