export const VERSION = '1.0.0';

export const IR_ARRAY_WIDTH = 120;
export const IR_ARRAY_HEIGHT = 160;
export const HEIGHT_WIDTH_RATIO = IR_ARRAY_HEIGHT / IR_ARRAY_WIDTH;
export const INTSIZE = 4; //4 Bytes per int

export const CHART_MARGIN = { top: 10, right: 20, bottom: 20, left: 0 };

export const PRESET_COLORS = ['#8884d8', '#f97356', '#1bc32c', '#c6502d', '#82ca9d', '#3eaec0', '#627682', '#445111'];

export const LINTPLOT_DATAPOINT_LIMIT = 25;

export const FPS = 5;

// Whether the videostore bucket serves CORS headers for canvas pixel reads. Flip to true ONLY after the
// bucket CORS is applied (see storage.cors.json + docs/palette-scale-bar-plan.md §4.4). While false the
// video player never sets crossOrigin and never tries palette auto-detection from a video frame — because
// setting crossOrigin on a video the bucket doesn't CORS-allow makes it fail to load. With it true, the
// player marks the video crossOrigin='anonymous' and detects the palette from a frame (utils/paletteDetect).
export const VIDEO_PIXEL_CORS_READY = false;
