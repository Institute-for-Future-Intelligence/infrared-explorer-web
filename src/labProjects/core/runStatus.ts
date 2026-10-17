/*
 * What a project's run is doing, in words: the status row on the project
 * page, and the line that marks a project as being worked on in the lists
 * (Home's Projects strip, the Projects page). One wording for all of them.
 */

import type {RunView} from './runner';
import {say, type Wording} from './types';

/** The words, by the app's i18n key (Wording in types.ts). */
export const RUN_STATUS_EN = {
  lab_status_thinking: 'Thinking…',
  lab_status_drawing: 'Drawing…',
  lab_status_drawing_named: 'Drawing: {caption}…',
  lab_status_summarizing: 'Condensing the earlier conversation…',
  lab_status_retrying: 'The connection to the AI dropped; trying again…',
  lab_status_overview: 'Preparing an overview of the new captures…',
  lab_status_writing_plan: 'Writing the plan…',
  lab_status_writing_report: 'Writing the report…',
  lab_status_viewing: 'Looking at pictures…',
  lab_status_naming: 'Naming the experiment…',
  lab_status_looking: 'Looking at the capture…',
  lab_status_measuring: 'Measuring…',
  lab_status_charting: 'Drawing a chart…',
  lab_status_placing_sensors: 'Placing sensors…',
  lab_status_running_code: 'Running the AI’s code…',
  lab_status_working: 'Working…',
  lab_status_replying: 'Replying…',
} as const;

export type RunStatusKey = keyof typeof RUN_STATUS_EN;

/** The words for a run's status code (runner.ts sets them from the server's status chunks and the phone tools). */
export function statusLabel(status: string | null, tr?: Wording<RunStatusKey>): string {
  const w = (key: RunStatusKey, params?: Record<string, string>) => say(RUN_STATUS_EN, key, tr, params);
  if (!status) {
    return w('lab_status_thinking');
  }
  if (status.startsWith('drawing:')) {
    const caption = status.slice(8);
    return caption ? w('lab_status_drawing_named', {caption}) : w('lab_status_drawing');
  }
  switch (status) {
    case 'sending':
    case 'thinking':
      return w('lab_status_thinking');
    case 'summarizing':
      return w('lab_status_summarizing');
    case 'retrying':
      return w('lab_status_retrying');
    case 'overview':
      return w('lab_status_overview');
    case 'tool:write_plan':
      return w('lab_status_writing_plan');
    case 'tool:write_report':
      return w('lab_status_writing_report');
    case 'tool:view':
      return w('lab_status_viewing');
    case 'tool:set_title':
      return w('lab_status_naming');
    case 'tool:draw':
      return w('lab_status_drawing');
    case 'phone:look':
      return w('lab_status_looking');
    case 'phone:measure':
      return w('lab_status_measuring');
    case 'phone:chart':
      return w('lab_status_charting');
    case 'phone:place_sensors':
      return w('lab_status_placing_sensors');
    case 'phone:run_code':
      return w('lab_status_running_code');
    default:
      return w('lab_status_working');
  }
}

/**
 * The line a list shows for a project the AI is working on, or null for one
 * it is not. A run this phone drives says what it is doing (a reply being
 * written: that one is). One running elsewhere — another device, or a request
 * the app lost, known from the server's `busy` — only that it is.
 */
export function workingLabel(run: RunView, busy: boolean | undefined, tr?: Wording<RunStatusKey>): string | null {
  if (run.running) {
    return run.liveText && !run.status ? say(RUN_STATUS_EN, 'lab_status_replying', tr) : statusLabel(run.status, tr);
  }
  return busy ? say(RUN_STATUS_EN, 'lab_status_working', tr) : null;
}
