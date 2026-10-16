/*
 * Website-side shim, not synced: the `../recordingFormat` the copied
 * core/sandboxPage.ts imports (the app's src/lib/recordingFormat.ts). The
 * frame's shape is the website's own (utils/constants.ts): 120 × 160 cells,
 * four bytes a cell with the centikelvin in the big-endian uint16 at +2,
 * which is what the website's thermalFrame.ts decodes.
 */

export { INTSIZE, IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from '../utils/constants';

export const IR_ARRAY_LENGTH = 120 * 160;
export const KELVIN_OFFSET = 273.15;
