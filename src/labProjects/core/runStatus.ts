/*
 * What a project's run is doing, in words: the status row on the project
 * page, and the line that marks a project as being worked on in the lists
 * (Home's Projects strip, the Projects page). One wording for all of them.
 */

import type {RunView} from './runner';

/** The words for a run's status code (runner.ts sets them from the server's status chunks and the phone tools). */
export function statusLabel(status: string | null): string {
  if (!status) {
    return 'Thinking…';
  }
  if (status.startsWith('drawing:')) {
    const cap = status.slice(8);
    return cap ? `Drawing: ${cap}…` : 'Drawing…';
  }
  switch (status) {
    case 'sending':
    case 'thinking':
      return 'Thinking…';
    case 'summarizing':
      return 'Condensing the earlier conversation…';
    case 'retrying':
      return 'The connection to the AI dropped; trying again…';
    case 'overview':
      return 'Preparing an overview of the new captures…';
    case 'tool:write_plan':
      return 'Writing the plan…';
    case 'tool:write_report':
      return 'Writing the report…';
    case 'tool:view':
      return 'Looking at pictures…';
    case 'tool:set_title':
      return 'Naming the experiment…';
    case 'tool:draw':
      return 'Drawing…';
    case 'phone:look':
      return 'Looking at the capture…';
    case 'phone:measure':
      return 'Measuring…';
    case 'phone:chart':
      return 'Drawing a chart…';
    case 'phone:place_sensors':
      return 'Placing sensors…';
    case 'phone:run_code':
      return 'Running the AI’s code…';
    default:
      return 'Working…';
  }
}

/**
 * The line a list shows for a project the AI is working on, or null for one
 * it is not. A run this phone drives says what it is doing (a reply being
 * written: that one is). One running elsewhere — another device, or a request
 * the app lost, known from the server's `busy` — only that it is.
 */
export function workingLabel(run: RunView, busy: boolean | undefined): string | null {
  if (run.running) {
    return run.liveText && !run.status ? 'Replying…' : statusLabel(run.status);
  }
  return busy ? 'Working…' : null;
}
