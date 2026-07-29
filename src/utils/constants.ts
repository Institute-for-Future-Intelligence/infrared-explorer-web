export const VERSION = '1.0.0';

export const IR_ARRAY_WIDTH = 120;
export const IR_ARRAY_HEIGHT = 160;
export const HEIGHT_WIDTH_RATIO = IR_ARRAY_HEIGHT / IR_ARRAY_WIDTH;
export const INTSIZE = 4; //4 Bytes per int

// top reserves a band above the plot for the horizontal Y-axis title (renderYAxisTitle) and the
// floating menu buttons, so neither covers the plot area.
export const CHART_MARGIN = { top: 26, right: 20, bottom: 20, left: 0 };

// Shared Y-axis band width. Just wide enough for the tick numbers ("150.0", "-10.0", "100%") — the
// axis title lives horizontally above the column (renderYAxisTitle), not in a rotated left gutter.
// Every chart uses the same width so the plot areas line up in the grid.
export const Y_AXIS_WIDTH = 44;

export const PRESET_COLORS = ['#8884d8', '#f97356', '#1bc32c', '#c6502d', '#82ca9d', '#3eaec0', '#627682', '#445111'];

// One distinct marker shape per series index (cycles), paired with PRESET_COLORS so a thermometer keeps
// the same colour+shape across the scatter plots and the shared chart colour key.
export const SERIES_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross'] as const;

// Downsample caps for the shared T(t)/scatter/histogram/profile frame set (see utils/sampleFrames.ts). The
// set is decoded by every chart and re-read on a chart rebuild, so it MUST fit inside the decoded-frame LRU
// (thermalFrame.ts CACHE_CAP, which is derived from LINEPLOT_POINTS_VIDEO) or a rebuild re-inflates frames.
// A VIDEO keeps every frame in memory, so sampling is network-free and we sample densely (reads as a
// continuous curve at any chart width). A RECORDING pays one Storage getBytes per sample, so its cap is a
// conservative bump over the old 25 and the fetches run bounded-parallel.
export const LINEPLOT_POINTS_VIDEO = 200;
export const LINEPLOT_POINTS_RECORDING = 50;

// Frames sampled for the AI thermal summary (Q&A / report / agent read_experiment_data). This is an
// INDEPENDENT, cost-bound budget — the user-facing charts sample far denser (LINEPLOT_POINTS_*), but the AI
// summary is serialised into the prompt, so it is deliberately kept small to bound tokens/cost, not raised
// in lockstep. Mirrored server-side by REPORT_FRAME_SAMPLES (functions/src/index.ts).
export const AI_FRAME_SAMPLES = 25;

export const FPS = 5;

// Whether the videostore bucket serves CORS headers for canvas pixel reads. Flip to true ONLY after the
// bucket CORS is applied (see storage.cors.json + docs/palette-scale-bar-plan.md §4.4). While false the
// video player never sets crossOrigin and never tries palette auto-detection from a video frame — because
// setting crossOrigin on a video the bucket doesn't CORS-allow makes it fail to load. With it true, the
// player marks the video crossOrigin='anonymous' and detects the palette from a frame (utils/paletteDetect).
export const VIDEO_PIXEL_CORS_READY = false;
