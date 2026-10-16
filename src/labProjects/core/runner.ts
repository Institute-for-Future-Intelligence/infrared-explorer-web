/*
 * Website-side shim, not synced (scripts/sync-lab-core.mjs leaves it alone).
 *
 * The copied runStatus.ts imports `type {RunView} from './runner'` — the
 * app's runner, which has no place here (it drives React Native's XHR and
 * the phone tools). The website's runner (../runner.ts) keeps the same
 * RunView shape; this file hands that type over under the path the copy
 * expects, so the copy stays verbatim.
 */

export type { RunView } from '../runner';
