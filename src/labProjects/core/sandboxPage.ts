/*
 * The page the AI's own code runs in (the run_code tool, runCode.ts): a
 * WebView with nothing of the app in it — no files, no native modules, no
 * network (a content-security policy) — only the temperature frames the app
 * hands in over the bridge, a 2D canvas, and a way back out: what the code
 * prints, returns and draws.
 *
 * Pure: the page's HTML and the scripts the app injects into it are built
 * here as strings, and the messages the page posts back are parsed here.
 * The frame codec is run in __tests__/labProjectsSandbox.test.ts, the page's
 * half evaluated from the same source the page carries.
 */

import {paletteRgba} from '../heatmap';
import {IR_ARRAY_HEIGHT, IR_ARRAY_LENGTH, IR_ARRAY_WIDTH, INTSIZE, KELVIN_OFFSET} from '../recordingFormat';

/**
 * Characters of print output a run may send back (and of a returned value).
 * Raised to 60,000 on 2026-10-15 after a run that printed a 108-row table as
 * indented JSON lost everything past 27 s, and put back the same day: the
 * two runs under 60,000 printed 46,000 and 60,000 characters of tables the
 * model never used (one returned the same table again), and every later
 * call carried them (a project's input went from 139k to 481k tokens). What
 * is cut is said in the output, with how much was dropped. The server keeps
 * a tool result up to MAX_RESULT_TEXT (turn.ts).
 */
export const PRINT_LIMIT = 20000;
/** Pictures a run may send back. */
export const PICTURE_LIMIT = 8;
/** A picture larger than this on its longest edge is scaled down. */
export const PICTURE_MAX_EDGE = 1600;
/**
 * Decoded frames the page keeps between calls (a call under way keeps all
 * of its own). A celsiusRange call has no cap: the model is given no limit
 * on how much of a take it reads (2026-10-15, the user's decision after the
 * model sampled 14 of 525 frames).
 */
export const CACHE_FRAMES = 600;
/**
 * Not a time budget — the model is told none — but the point past which code
 * that never finishes (a loop that never yields) is taken to be stuck and
 * its page let go, so the sandbox is not held forever.
 */
export const RUNAWAY_LIMIT_MS = 10 * 60_000;
/**
 * Characters of JSON the values a project's code saves (`save(name, value)`)
 * may hold in all; they are kept with the project for later runs (2026-10-15,
 * so a run can build on the last one's results as a script reads the file
 * the one before it wrote).
 */
export const SAVED_LIMIT = 4 * 1024 * 1024;
/** How long the page waits to say it is ready after it is mounted. */
export const PAGE_START_LIMIT_MS = 15_000;
/** Frames per injected chunk: 8 × 38.4 kB of bytes, about 410 k characters of script. */
export const FRAMES_PER_CHUNK = 8;
/**
 * Frames the page asks for at once when the code reads frames near the one
 * it read last: a walk frame by frame, or in strides (one a second is a
 * stride of 5). 10-15 on the S20: a round trip per frame made 525 frames
 * take 52 s, and the model's usual one-a-second loop 106 frames 11 s. A
 * jump farther than this fetches just what was asked.
 */
export const FRAME_PREFETCH = 32;

// ------------------------------------------------------------- the takes

/** A sensor as the code sees it: a point or area (centre and full size), or a line; fractions of the image. */
export type SandboxSensor =
  | {name: string; type: 'point' | 'rect' | 'ellipse'; x: number; y: number; w?: number; h?: number}
  | {name: string; type: 'line'; x1: number; y1: number; x2: number; y2: number};

/** What the page is told of a take; its frames come later, on request. */
export interface TakeMeta {
  id: string;
  name: string;
  kind: 'recording' | 'time-lapse recording' | 'photo';
  frameCount: number;
  width: number;
  height: number;
  /** Seconds of each frame from the start, indexed from 0. */
  times: number[];
  secondsPerFrame: number;
  emissivity: number | null;
  sensors: SandboxSensor[];
  camera: {movedDuring: [number, number][]; shutterCalibrationsAt: number[]} | null;
  visibleLightKept: boolean;
}

// ----------------------------------------------------------- frame codec

const BYTES_PER_PIXEL = 2;
const FRAME_BYTES = IR_ARRAY_LENGTH * BYTES_PER_PIXEL;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* eslint-disable no-bitwise -- base64 packs three bytes into four sextets */
function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==');
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    parts.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=');
  }
  return parts.join('');
}
/* eslint-enable no-bitwise */

/**
 * Frames for the page, as base64: each raw (inflated) .dat body reduced to
 * its 16-bit centikelvin per pixel, big-endian, 38,400 bytes a frame — the
 * same two bytes of each 4-byte record that readDatFrameCelsius reads, so the
 * page's temperatures are the app's. A null frame (unreadable) is sent as
 * zeros and named in `missing`, which the page fills with NaN.
 */
export function encodeFrames(raws: (Uint8Array | null)[]): string {
  const out = new Uint8Array(raws.length * FRAME_BYTES);
  let p = 0;
  for (const raw of raws) {
    for (let i = 0; i < IR_ARRAY_LENGTH; i++) {
      const off = i * INTSIZE + 2;
      if (raw && off + 2 <= raw.length) {
        out[p++] = raw[off];
        out[p++] = raw[off + 1];
      } else {
        p += 2;
      }
    }
  }
  return bytesToBase64(out);
}

/**
 * The page's half of the codec, as the source of a function
 * (b64, missing) → Float32Array[]: centikelvin / 100 − 273.15 into a
 * Float32Array, as readDatFrameCelsius does, NaN for the frames in `missing`
 * (offsets within the chunk). Kept as a string so the test runs the very
 * code the page runs.
 */
export const FRAME_DECODER_JS = `
  var N = ${IR_ARRAY_LENGTH};
  var bin = atob(b64);
  var count = Math.floor(bin.length / (N * 2));
  var frames = [];
  for (var f = 0; f < count; f++) {
    var out = new Float32Array(N);
    if (missing && missing.indexOf(f) >= 0) {
      out.fill(NaN);
    } else {
      var base = f * N * 2;
      for (var i = 0; i < N; i++) {
        var o = base + i * 2;
        out[i] = (bin.charCodeAt(o) * 256 + bin.charCodeAt(o + 1)) / 100 - ${KELVIN_OFFSET};
      }
    }
    frames.push(out);
  }
  return frames;
`;

// ------------------------------------------------------------ the page

/** The app's iron palette as 256 RGB triples, for the page's thermalCanvas. */
function ironPalette(): number[] {
  const ramp = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    ramp[i] = i;
  }
  const rgba = paletteRgba(ramp, 0, 255, 'iron');
  const out: number[] = [];
  for (let i = 0; i < 256; i++) {
    const o = i * 4;
    out.push(rgba ? rgba[o] : i, rgba ? rgba[o + 1] : i, rgba ? rgba[o + 2] : i);
  }
  return out;
}

/*
 * The page's runtime. Plain ES5-ish script (no template literals, so this
 * file's own interpolation stays readable); the few values it takes from the
 * app are substituted below.
 */
const RUNTIME = `
(function () {
  'use strict';
  var RN = window.ReactNativeWebView;
  var W = __W__, H = __H__, N = W * H;
  var PAL = __PALETTE__;
  var PRINT_LIMIT = __PRINT_LIMIT__, PICTURE_LIMIT = __PICTURE_LIMIT__, MAX_EDGE = __MAX_EDGE__, CACHE_FRAMES = __CACHE_FRAMES__, PREFETCH = __PREFETCH__, SAVED_LIMIT = __SAVED_LIMIT__;
  function post(o) { RN.postMessage(JSON.stringify(o)); }
  function decodeFrames(b64, missing) { __DECODER__ }

  // ---- asking the app for things (frames, visible-light pictures)
  var pending = {}, nextId = 1;
  function ask(what, args) {
    return new Promise(function (res, rej) {
      var id = nextId++;
      pending[id] = {res: res, rej: rej};
      var m = {t: 'need', id: id, what: what};
      for (var k in args) { m[k] = args[k]; }
      post(m);
    });
  }

  // ---- decoded frames, per take: the most recent CACHE_FRAMES kept, and
  // never fewer than the calls under way are about to hand back (holds)
  var caches = [];
  var framesRead = 0;
  function cacheOf(t) { return caches[t] || (caches[t] = {map: Object.create(null), order: [], lastAsk: null, lastStride: null, holds: []}); }
  function remember(t, i, frame) {
    var c = cacheOf(t);
    if (!(i in c.map)) { c.order.push(i); }
    c.map[i] = frame;
    var keep = CACHE_FRAMES;
    for (var h = 0; h < c.holds.length; h++) { keep += c.holds[h].n; }
    while (c.order.length > keep) { delete c.map[c.order.shift()]; }
  }

  // ---- the run under way
  var current = null;
  var runTakes = [];
  // numbers in what is printed or returned: the stored step is 0.01 °C, and
  // a run printed 15-digit means into a 46,000-character table (10-15)
  function round3(k, v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 1000) / 1000 : v; }
  // a string that is itself JSON (print(JSON.stringify(rows)) — 10-15, 15-digit means again) is rounded the same way
  function roundJsonText(s) {
    var t = s.replace(/^\\s+/, '');
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') { return s; }
    try { return JSON.stringify(JSON.parse(s), round3); } catch (e) { return s; }
  }
  // parsing: the error came from building the function, before any of the
  // code ran; V8 names no line of the code for those, and the frame the
  // search below would find is the runtime's own (10-15: an await in a plain
  // arrow function was reported as "line 1 of the code")
  function describe(e, parsing, hint) {
    if (e && typeof e === 'object' && 'message' in e) {
      var name = e.name || 'Error';
      var where = '';
      if (parsing) {
        where = ' (the code could not be parsed, so nothing ran' + (hint || '') + ')';
      } else {
        // V8 counts from the Function constructor's two-line header; the code starts after two more lines
        var stack = String(e.stack || '').split('\\n');
        for (var i = 0; i < stack.length; i++) {
          var m = /<anonymous>:(\\d+):(\\d+)/.exec(stack[i]);
          if (m) { where = ' (line ' + Math.max(1, Number(m[1]) - 4) + ' of the code)'; break; }
        }
      }
      return name + ': ' + e.message + where;
    }
    return String(e);
  }
  function print() {
    if (!current) { return; }
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (typeof a === 'string') { parts.push(roundJsonText(a)); }
      else if (a === undefined) { parts.push('undefined'); }
      else if (typeof a === 'number') { parts.push(String(round3('', a))); }
      else if (ArrayBuffer.isView(a)) { parts.push(JSON.stringify(Array.prototype.slice.call(a), round3)); }
      else { try { parts.push(JSON.stringify(a, round3)); } catch (e) { parts.push(String(a)); } }
    }
    var s = parts.join(' ') + '\\n';
    if (current.truncated) { current.dropped += s.length; return; }
    if (current.printedLen + s.length > PRINT_LIMIT) {
      var keep = Math.max(0, PRINT_LIMIT - current.printedLen);
      current.dropped += s.length - keep;
      s = s.slice(0, keep) + '\\n[print output cut at ' + PRINT_LIMIT + ' characters]\\n';
      current.truncated = true;
    }
    current.printedLen += s.length;
    post({t: 'print', runId: current.runId, s: s});
  }
  function picture(c, caption) {
    if (!current) { return 0; }
    if (current.pictures >= PICTURE_LIMIT) { throw new Error('At most ' + PICTURE_LIMIT + ' pictures per run.'); }
    var png = null;
    if (typeof c === 'string') {
      var at = c.indexOf('base64,');
      if (c.indexOf('data:image/png') !== 0 || at < 0) { throw new Error('picture() takes a canvas (or a PNG data URL).'); }
      png = c.slice(at + 7);
    } else {
      var canvas = c;
      if (c && c.tagName === 'IMG') {
        canvas = document.createElement('canvas');
        canvas.width = c.naturalWidth || c.width;
        canvas.height = c.naturalHeight || c.height;
        canvas.getContext('2d').drawImage(c, 0, 0);
      }
      if (!canvas || typeof canvas.toDataURL !== 'function') { throw new Error('picture() takes a canvas.'); }
      var longest = Math.max(canvas.width, canvas.height);
      if (longest > MAX_EDGE) {
        var s = MAX_EDGE / longest;
        var small = document.createElement('canvas');
        small.width = Math.max(1, Math.round(canvas.width * s));
        small.height = Math.max(1, Math.round(canvas.height * s));
        small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
        canvas = small;
      }
      var url = canvas.toDataURL('image/png');
      png = url.slice(url.indexOf(',') + 1);
    }
    current.pictures += 1;
    post({t: 'picture', runId: current.runId, index: current.pictures, caption: String(caption == null ? '' : caption).slice(0, 300), png: png});
    return current.pictures;
  }
  // ---- values kept with the project between runs
  var saved = {};
  function savedSize(except) {
    var n = 0;
    for (var k in saved) { if (k !== except) { n += saved[k].length; } }
    return n;
  }
  function save(name, value) {
    if (!current) { return; }
    if (typeof name !== 'string' || !name.trim() || name.length > 100) { throw new Error('save() takes a name (a string of up to 100 characters) and a value.'); }
    if (value === undefined || value === null) {
      delete saved[name];
      post({t: 'save', runId: current.runId, name: name, json: null});
      return;
    }
    var json;
    try { json = JSON.stringify(ArrayBuffer.isView(value) ? Array.prototype.slice.call(value) : value); } catch (e) { throw new Error('save("' + name + '"): the value cannot be written as JSON (' + describe(e) + ').'); }
    if (typeof json !== 'string') { throw new Error('save("' + name + '"): the value cannot be written as JSON.'); }
    if (savedSize(name) + json.length > SAVED_LIMIT) {
      throw new Error('save("' + name + '"): the saved values would be ' + (savedSize(name) + json.length) + ' characters of JSON in all; at most ' + SAVED_LIMIT + ' are kept. Save less, or save(name, null) to drop one.');
    }
    saved[name] = json;
    post({t: 'save', runId: current.runId, name: name, json: json});
  }
  function load(name) {
    if (typeof name !== 'string') { throw new Error('load() takes the name of a saved value.'); }
    return name in saved ? JSON.parse(saved[name]) : null;
  }
  function thermalCanvas(cel, min, max, scale, opts) {
    scale = Math.max(1, Math.min(8, Math.round(Number(scale) || 1)));
    min = Number(min); max = Number(max);
    if (!isFinite(min) || !isFinite(max)) {
      // no scale given: the frame's own range
      var lo = Infinity, hi = -Infinity;
      for (var q = 0; q < N; q++) { var x = cel ? cel[q] : NaN; if (isFinite(x)) { if (x < lo) { lo = x; } if (x > hi) { hi = x; } } }
      if (!isFinite(min)) { min = lo; }
      if (!isFinite(max)) { max = hi; }
    }
    var base = document.createElement('canvas');
    base.width = W; base.height = H;
    var ctx = base.getContext('2d');
    var img = ctx.createImageData(W, H);
    var d = img.data;
    var span = max - min;
    for (var i = 0; i < N; i++) {
      var v = cel ? cel[i] : NaN;
      var idx = 0;
      if (span > 0 && isFinite(v)) {
        var t = (v - min) / span;
        idx = t <= 0 ? 0 : t >= 1 ? 255 : Math.floor(t * 256);
      }
      var o = i * 4, p = idx * 3;
      d[o] = PAL[p]; d[o + 1] = PAL[p + 1]; d[o + 2] = PAL[p + 2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    var out = base;
    if (scale > 1) {
      out = document.createElement('canvas');
      out.width = W * scale; out.height = H * scale;
      var cx = out.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.drawImage(base, 0, 0, out.width, out.height);
    }
    if (opts && opts.grid) {
      // pixel ticks, so a place in the picture can be read as x, y
      var gv = opts.grid === true ? 20 : Number(opts.grid);
      var step = isFinite(gv) && gv >= 2 ? Math.round(gv) : 20;
      var g = out.getContext('2d');
      g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1;
      for (var gx = step; gx < W; gx += step) { g.beginPath(); g.moveTo(gx * scale + 0.5, 0); g.lineTo(gx * scale + 0.5, H * scale); g.stroke(); }
      for (var gy = step; gy < H; gy += step) { g.beginPath(); g.moveTo(0, gy * scale + 0.5); g.lineTo(W * scale, gy * scale + 0.5); g.stroke(); }
      if (scale >= 2) {
        g.font = Math.min(14, 5 * scale) + 'px sans-serif';
        g.textBaseline = 'top'; g.textAlign = 'left';
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.fillStyle = '#ffffff';
        for (var lx = step; lx < W; lx += step) { g.strokeText(String(lx), lx * scale + 2, 2); g.fillText(String(lx), lx * scale + 2, 2); }
        for (var ly = step; ly < H; ly += step) { g.strokeText(String(ly), 2, ly * scale + 2); g.fillText(String(ly), 2, ly * scale + 2); }
      }
    }
    if (opts && opts.marks && opts.marks.length) {
      // each place read, outlined and labelled, so that a name the report
      // uses (t1, cup, wall) can be found in the picture; a mark is
      // {label, region} with region in any form stats takes, a sensor of
      // take.sensors as it is (its name is the label), or a line
      var mc = out.getContext('2d');
      var fs = Math.max(10, Math.min(16, 5 * scale));
      mc.font = 'bold ' + fs + 'px sans-serif'; mc.textBaseline = 'top'; mc.textAlign = 'left'; mc.lineJoin = 'round';
      var twice = function (draw) {
        mc.lineWidth = Math.max(3, scale + 2); mc.strokeStyle = 'rgba(0,0,0,0.8)'; mc.beginPath(); draw(); mc.stroke();
        mc.lineWidth = Math.max(1.5, scale / 2 + 1); mc.strokeStyle = '#ffffff'; mc.beginPath(); draw(); mc.stroke();
      };
      var frac = function (v, full) { return Math.max(0, Math.min(1, Number(v) || 0)) * full * scale; };
      for (var mi = 0; mi < opts.marks.length; mi++) {
        var mk = opts.marks[mi];
        if (mk == null) { continue; }
        var label = mk.label != null ? String(mk.label) : mk.name != null ? String(mk.name) : String(mi + 1);
        var src = mk.region != null ? mk.region : mk;
        var lx, ly;
        if (src && typeof src === 'object' && !Array.isArray(src) && src.type === 'line' && isNum(Number(src.x1)) && isNum(Number(src.y1)) && isNum(Number(src.x2)) && isNum(Number(src.y2))) {
          var ax = frac(src.x1, W), ay = frac(src.y1, H), bx = frac(src.x2, W), by = frac(src.y2, H);
          twice(function () { mc.moveTo(ax, ay); mc.lineTo(bx, by); });
          lx = bx + 4; ly = by - fs / 2;
        } else {
          var g = region(src, 'thermalCanvas marks');
          var x0 = g.x0 * scale, y0 = g.y0 * scale, x1 = g.x1 * scale, y1 = g.y1 * scale;
          if (g.x1 - g.x0 <= 1 && g.y1 - g.y0 <= 1) {
            var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = Math.max(4, 3 * scale);
            twice(function () { mc.arc(cx, cy, r, 0, Math.PI * 2); mc.moveTo(cx - r * 1.7, cy); mc.lineTo(cx - r, cy); mc.moveTo(cx + r, cy); mc.lineTo(cx + r * 1.7, cy); });
            lx = cx + r + 3; ly = cy - r - fs;
          } else if (g.ellipse) {
            twice(function () { mc.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2); });
            lx = x0; ly = y0 - fs - 2;
          } else {
            twice(function () { mc.rect(x0, y0, x1 - x0, y1 - y0); });
            lx = x0; ly = y0 - fs - 2;
          }
        }
        var tw = mc.measureText(label).width;
        lx = Math.max(1, Math.min(lx, W * scale - tw - 1));
        ly = Math.max(1, Math.min(ly, H * scale - fs - 1));
        mc.lineWidth = 3; mc.strokeStyle = 'rgba(0,0,0,0.8)'; mc.strokeText(label, lx, ly);
        mc.fillStyle = '#ffffff'; mc.fillText(label, lx, ly);
      }
    }
    return out;
  }
__LIBRARY__
  function makeTake(meta, t) {
    var take = {};
    for (var k in meta) { take[k] = meta[k]; }
    var last = Math.max(0, meta.frameCount - 1);
    function index(i) {
      var n = Math.round(Number(i));
      if (!isFinite(n)) { throw new Error('A frame index must be a number; got ' + i + '.'); }
      return Math.min(last, Math.max(0, n));
    }
    take.frameAt = function (seconds) {
      var s = Number(seconds) || 0;
      var times = meta.times;
      var best = 0;
      for (var i = 1; i < times.length; i++) {
        if (Math.abs(times[i] - s) < Math.abs(times[best] - s)) { best = i; }
      }
      return best;
    };
    take.timeOf = function (i) { return meta.times[index(i)] || 0; };
    take.celsiusRange = function (from, to) {
      var a = index(from == null ? 0 : from);
      var b = index(to == null ? last : to);
      if (b < a) { var tmp = a; a = b; b = tmp; }
      var c = cacheOf(t);
      // the whole range is kept decoded until it is handed back, and what
      // of it is already decoded counts as newest, so fetching the rest
      // does not push it out
      var hold = {n: b - a + 1};
      c.holds.push(hold);
      var held = [], rest = [];
      for (var q = 0; q < c.order.length; q++) { (c.order[q] >= a && c.order[q] <= b ? held : rest).push(c.order[q]); }
      c.order = rest.concat(held);
      // A round trip through the app costs about 100 ms, and each frame
      // read some 50 ms more, so code that reads frames one at a time is
      // read ahead by PREFETCH frames from the one it asked for, in the
      // direction it is moving, and its later reads hit the cache. A walk
      // in strides — one a second is every 5th frame; the same stride twice
      // running — is read ahead in that stride, so the frames between are
      // never read (a 19-minute recording read whole at every 5th frame
      // went past the 10-minute stop, 2026-10-15). Any other step, or a
      // range, reads ahead frame by frame; a jump farther than PREFETCH from
      // the last ask (a frame at the end after one at the start) fetches
      // just what was asked.
      var prevAsk = c.lastAsk, prevStride = c.lastStride;
      var stride = prevAsk == null ? null : a - prevAsk;
      c.lastAsk = a;
      c.lastStride = stride;
      var missing = false;
      for (var k0 = a; k0 <= b; k0++) { if (!(k0 in c.map)) { missing = true; break; } }
      var asks = [];
      if (missing && a === b && stride != null && stride !== 0 && stride === prevStride) {
        var step = Math.abs(stride), dir = stride > 0 ? 1 : -1, want = [];
        for (var q0 = 0; q0 < PREFETCH; q0++) {
          var f0 = a + dir * q0 * step;
          if (f0 < 0 || f0 > last) { break; }
          if (!(f0 in c.map)) { want.push(f0); }
        }
        want.sort(function (x, y) { return x - y; });
        var w0 = 0;
        while (w0 < want.length) {
          var w1 = w0;
          while (w1 + 1 < want.length && want[w1 + 1] - want[w1] === step) { w1++; }
          asks.push([want[w0], want[w1], step]);
          w0 = w1 + 1;
        }
      } else if (missing) {
        var fetchFrom = a, fetchTo = b;
        var by = stride == null ? 1 : stride;
        if (by >= 0 && by <= PREFETCH) { fetchTo = Math.min(last, Math.max(b, a + PREFETCH - 1)); }
        else if (by < 0 && -by <= PREFETCH) { fetchFrom = Math.max(0, Math.min(a, b - PREFETCH + 1)); }
        var i = fetchFrom;
        while (i <= fetchTo) {
          if (i in c.map) { i++; continue; }
          var j = i;
          while (j + 1 <= fetchTo && !((j + 1) in c.map)) { j++; }
          asks.push([i, j, 1]);
          i = j + 1;
        }
      }
      function release() { var at = c.holds.indexOf(hold); if (at >= 0) { c.holds.splice(at, 1); } }
      var chain = Promise.resolve();
      asks.forEach(function (r) {
        chain = chain.then(function () { return ask('frames', {take: t, from: r[0], to: r[1], step: r[2]}); });
      });
      return chain.then(function () {
        var out = [];
        for (var k = a; k <= b; k++) {
          var f = c.map[k];
          if (!f) { f = new Float32Array(N); f.fill(NaN); }
          out.push(f);
        }
        release();
        return out;
      }, function (e) { release(); throw e; });
    };
    take.celsius = function (i) { return take.celsiusRange(i, i).then(function (r) { return r[0]; }); };
    take.visible = function (i) {
      if (!meta.visibleLightKept) { return Promise.resolve(null); }
      return ask('visible', {take: t, i: index(i)}).then(function (url) {
        if (!url) { return null; }
        return new Promise(function (res, rej) {
          var img = new Image();
          img.onload = function () { res(img); };
          img.onerror = function () { rej(new Error('The visible-light frame could not be decoded.')); };
          img.src = url;
        });
      });
    };
    return take;
  }

  function finish(runId, started, ok, value, error) {
    if (!current || current.runId !== runId) { return; }
    var returned = null;
    if (ok && value !== undefined) {
      try { returned = JSON.stringify(value, round3); } catch (e) { returned = JSON.stringify(String(value)); }
      if (returned && returned.length > PRINT_LIMIT) { returned = JSON.stringify(returned.slice(0, PRINT_LIMIT) + ' [cut, ' + (returned.length - PRINT_LIMIT) + ' more characters]'); }
    }
    if (current.dropped > 0) { post({t: 'print', runId: runId, s: '[' + current.dropped + ' more characters were printed after the cut and not sent]\\n'}); }
    current = null;
    post({t: 'done', runId: runId, ok: ok, returned: returned, error: error || null, ms: Date.now() - started, framesRead: framesRead});
  }

  window.__sb = {
    frames: function (t, start, b64, missing, step) {
      var list = decodeFrames(b64, missing || []);
      var by = Math.max(1, Math.round(Number(step)) || 1);
      for (var k = 0; k < list.length; k++) { remember(t, start + k * by, list[k]); }
      framesRead += list.length;
    },
    answer: function (id, ok, payload) {
      var p = pending[id];
      delete pending[id];
      if (!p) { return; }
      if (ok) { p.res(payload); } else { p.rej(new Error(String(payload))); }
    },
    run: function (runId, code, takesMeta, savedNow) {
      var started = Date.now();
      framesRead = 0;
      current = {runId: runId, printedLen: 0, truncated: false, dropped: 0, pictures: 0};
      saved = {};
      if (savedNow && typeof savedNow === 'object') { for (var sk in savedNow) { if (typeof savedNow[sk] === 'string') { saved[sk] = savedNow[sk]; } } }
      var takes = [];
      for (var i = 0; i < takesMeta.length; i++) { takes.push(makeTake(takesMeta[i], i)); }
      runTakes = takes;
      var fn;
      try {
        fn = new Function(
          'take', 'takes', 'print', 'picture', 'thermalCanvas', 'save', 'load',
          'stats', 'percentile', 'rowProfile', 'colProfile', 'lineProfile', 'series', 'smooth', 'firstTime', 'fitLine', 'fitExp', 'mask', 'components', 'plot', 'table',
          '"use strict";\\nreturn (async function () {\\n' + code + '\\n})();'
        );
      } catch (e) {
        // The slip seen twice on 2026-10-15 (pc2dfac8, p733ccbe7): an await
        // inside a map or forEach callback. V8 words it differently by
        // context (await is only valid in async functions / Unexpected
        // identifier), so it is told apart by whether the code parses once
        // its awaits are taken out.
        var hint = '';
        if (/\\bawait\\b/.test(code)) {
          try {
            new Function('"use strict";\\nreturn (async function () {\\n' + code.replace(/\\bawait\\b/g, '') + '\\n})();');
            hint = '; await works at the top level of the code and in its loops, but inside a callback such as map or forEach only when that callback is itself async';
          } catch (e2) { hint = ''; }
        }
        finish(runId, started, false, undefined, describe(e, true, hint));
        return;
      }
      var p;
      try {
        p = Promise.resolve(fn(
          takes[0], takes, print, picture, thermalCanvas, save, load,
          stats, percentile, rowProfile, colProfile, lineProfile, series, smooth, firstTime, fitLine, fitExp, mask, components, plot, table
        ));
      } catch (e) {
        finish(runId, started, false, undefined, describe(e));
        return;
      }
      p.then(function (v) { finish(runId, started, true, v); }, function (e) { finish(runId, started, false, undefined, describe(e)); });
    }
  };
  post({t: 'ready'});
})();
`;

/*
 * The analysis helpers in the code's scope (user decision ㊼, 2026-10-15:
 * what a hand-written analysis of a take was made of — frame statistics
 * with the hottest point, row and column profiles, a series over the frames,
 * smoothing, first crossings, line and exponential fits, masks and connected
 * regions, a chart and a text table — so the code starts from them instead
 * of from area means, and spends its lines on the analysis rather than on
 * axes and legends). Spliced into RUNTIME at __LIBRARY__; runs in the same
 * closure (W, H, N, isNum helpers, runTakes). Same ES5 style, same rule
 * about template literals. Tested from the page's own source in
 * __tests__/labProjectsSandboxLibrary.test.ts.
 */
const LIBRARY = `
  // ---- analysis helpers (the run_code description lists them)
  function numeric(a, b) { return a - b; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function checkFrame(frame, who) {
    if (!frame || typeof frame.length !== 'number' || frame.length !== N) { throw new Error(who + ' takes a frame (what take.celsius gives: ' + N + ' values).'); }
  }
  function toArray(v, who) {
    if (ArrayBuffer.isView(v)) { return Array.prototype.slice.call(v); }
    if (Array.isArray(v)) { return v.map(Number); }
    throw new Error(who + ' takes an array of numbers.');
  }
  // Four numbers are fractions of the image when none is beyond FRACTION_MAX
  // (a pixel region of that size would be a pixel or two); a fraction a
  // little outside the image (a sensor half off its edge) is clipped to it.
  var FRACTION_MAX = 1.5;
  function fractionsToPixels(a) {
    for (var q = 0; q < 4; q++) { if (a[q] > FRACTION_MAX) { return a; } }
    var out = [];
    for (var k = 0; k < 4; k++) { out.push(Math.max(0, Math.min(1, a[k])) * (k % 2 === 0 ? W : H)); }
    return out;
  }
  // A region: [x0, y0, x1, y1] in pixels, x1 and y1 exclusive (fractions of
  // the image when none is beyond FRACTION_MAX), or a sensor-like {x, y, w, h}
  // (centre and full size, always fractions; without w and h, one pixel;
  // type 'ellipse' is read as one). Nothing is the whole frame.
  function region(r, who) {
    if (r == null) { return {x0: 0, y0: 0, x1: W, y1: H, ellipse: false}; }
    var a, ellipse = false;
    if (Array.isArray(r) || ArrayBuffer.isView(r)) {
      if (r.length !== 4) { throw new Error(who + ': a region is [x0, y0, x1, y1].'); }
      a = [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3])];
      for (var i = 0; i < 4; i++) { if (!isNum(a[i])) { throw new Error(who + ': a region needs four numbers.'); } }
      a = fractionsToPixels(a);
    } else if (r && typeof r === 'object') {
      if (r.type === 'line') { throw new Error(who + ': a line is not a region; lineProfile reads along a line.'); }
      // the corners as an object, {x0, y0, x1, y1} or {left, top, right, bottom}
      // (10-15, p73ed1110: the model's first region was {x0, y0, x1, y1} and lost a run to it)
      var corners = isNum(Number(r.x0)) && isNum(Number(r.y0)) && isNum(Number(r.x1)) && isNum(Number(r.y1))
        ? [Number(r.x0), Number(r.y0), Number(r.x1), Number(r.y1)]
        : isNum(Number(r.left)) && isNum(Number(r.top)) && isNum(Number(r.right)) && isNum(Number(r.bottom))
          ? [Number(r.left), Number(r.top), Number(r.right), Number(r.bottom)]
          : null;
      if (corners) { a = fractionsToPixels(corners); }
      else if (!isNum(Number(r.x)) || !isNum(Number(r.y))) { throw new Error(who + ': a region is [x0, y0, x1, y1] or {x0, y0, x1, y1} (pixels, or fractions of the image), or a sensor-like {x, y, w, h}.'); }
      else {
      var w = isNum(Number(r.w)) ? Number(r.w) : 0, h = isNum(Number(r.h)) ? Number(r.h) : 0;
      // always fractions, however far w and h reach past the edge (10-15: a
      // cup region {x: 0.5, y: 0.91, w: 0.32, h: 0.2} read as pixels became one corner pixel);
      // a centre or size in pixels is refused rather than clipped (10-16, p96ff65f9:
      // {x: 60, y: 47, w: 0.06, h: 0.06} three times read one corner pixel three times, as identical T1, T2, T3 columns)
      if (Number(r.x) > FRACTION_MAX || Number(r.y) > FRACTION_MAX || Math.abs(w) > FRACTION_MAX || Math.abs(h) > FRACTION_MAX) {
        throw new Error(who + ': {x, y, w, h} is fractions of the image (' + JSON.stringify({x: r.x, y: r.y, w: r.w, h: r.h}) + ' is not); pixels go as [x0, y0, x1, y1].');
      }
      var cx = Math.max(0, Math.min(1, Number(r.x))) * W, cy = Math.max(0, Math.min(1, Number(r.y))) * H;
      var hw = Math.abs(w) / 2 * W, hh = Math.abs(h) / 2 * H;
      a = [cx - hw, cy - hh, cx + hw, cy + hh];
      ellipse = r.type === 'ellipse';
      }
    } else {
      throw new Error(who + ': a region is [x0, y0, x1, y1] or {x0, y0, x1, y1} (pixels, or fractions of the image), or a sensor-like {x, y, w, h}.');
    }
    var x0 = Math.round(Math.min(a[0], a[2])), x1 = Math.round(Math.max(a[0], a[2]));
    var y0 = Math.round(Math.min(a[1], a[3])), y1 = Math.round(Math.max(a[1], a[3]));
    x0 = Math.max(0, Math.min(W - 1, x0)); y0 = Math.max(0, Math.min(H - 1, y0));
    x1 = Math.max(x0 + 1, Math.min(W, x1)); y1 = Math.max(y0 + 1, Math.min(H, y1));
    return {x0: x0, y0: y0, x1: x1, y1: y1, ellipse: ellipse};
  }
  function eachPixel(g, fn) {
    if (!g.ellipse) {
      for (var y = g.y0; y < g.y1; y++) { for (var x = g.x0; x < g.x1; x++) { fn(x, y); } }
      return;
    }
    var cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2, rx = (g.x1 - g.x0) / 2, ry = (g.y1 - g.y0) / 2;
    for (var ey = g.y0; ey < g.y1; ey++) {
      for (var ex = g.x0; ex < g.x1; ex++) {
        var dx = (ex + 0.5 - cx) / rx, dy = (ey + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) { fn(ex, ey); }
      }
    }
  }
  function quantile(sorted, p) {
    if (!sorted.length) { return NaN; }
    var pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function stats(frame, r) {
    checkFrame(frame, 'stats()');
    var g = region(r, 'stats()');
    var vals = [], sum = 0, mn = Infinity, mx = -Infinity, hot = null, cold = null;
    eachPixel(g, function (x, y) {
      var v = frame[y * W + x];
      if (!isNum(v)) { return; }
      vals.push(v); sum += v;
      if (v > mx) { mx = v; hot = {x: x, y: y}; }
      if (v < mn) { mn = v; cold = {x: x, y: y}; }
    });
    var n = vals.length;
    if (!n) { return {n: 0, min: NaN, max: NaN, mean: NaN, median: NaN, p10: NaN, p90: NaN, sd: NaN, hottest: null, coldest: null}; }
    vals.sort(numeric);
    var mean = sum / n, ss = 0;
    for (var i = 0; i < n; i++) { ss += (vals[i] - mean) * (vals[i] - mean); }
    return {n: n, min: mn, max: mx, mean: mean, median: quantile(vals, 0.5), p10: quantile(vals, 0.1), p90: quantile(vals, 0.9), sd: Math.sqrt(ss / n), hottest: hot, coldest: cold};
  }
  function percentile(frame, p, r) {
    checkFrame(frame, 'percentile()');
    var q = Number(p);
    if (!isFinite(q)) { throw new Error('percentile() takes a frame and p (a fraction 0..1, or a percent).'); }
    if (q > 1) { q = q / 100; }
    q = Math.max(0, Math.min(1, q));
    var g = region(r, 'percentile()'), vals = [];
    eachPixel(g, function (x, y) { var v = frame[y * W + x]; if (isNum(v)) { vals.push(v); } });
    vals.sort(numeric);
    return quantile(vals, q);
  }
  function axisIndex(v, limit, who) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) { throw new Error(who + ': ' + v + ' is not a pixel index.'); }
    return Math.max(0, Math.min(limit - 1, n));
  }
  function rowProfile(frame, y, x0, x1) {
    checkFrame(frame, 'rowProfile()');
    var yy = axisIndex(y, H, 'rowProfile()');
    var a = x0 == null ? 0 : axisIndex(x0, W, 'rowProfile()');
    var b = x1 == null ? W : Math.max(a + 1, Math.min(W, Math.round(Number(x1)) || 0));
    var out = [];
    for (var x = a; x < b; x++) { out.push(frame[yy * W + x]); }
    return out;
  }
  function colProfile(frame, x, y0, y1) {
    checkFrame(frame, 'colProfile()');
    var xx = axisIndex(x, W, 'colProfile()');
    var a = y0 == null ? 0 : axisIndex(y0, H, 'colProfile()');
    var b = y1 == null ? H : Math.max(a + 1, Math.min(H, Math.round(Number(y1)) || 0));
    var out = [];
    for (var y = a; y < b; y++) { out.push(frame[y * W + xx]); }
    return out;
  }
  // the samples along a line as a list of {x, y, value} points — what the
  // model takes it for (p733ccbe7 10-15, p9b8fa0ef 10-16: .filter and
  // .map on it, each losing a run) — that also carries x, y and value as
  // whole arrays, the earlier form; the line's ends as four numbers, or as
  // one of take.sensors' lines ({x1, y1, x2, y2})
  function lineProfile(frame, x1, y1, x2, y2) {
    checkFrame(frame, 'lineProfile()');
    var p = x1 != null && typeof x1 === 'object' && y1 == null
      ? [Number(x1.x1), Number(x1.y1), Number(x1.x2), Number(x1.y2)]
      : [Number(x1), Number(y1), Number(x2), Number(y2)];
    for (var i = 0; i < 4; i++) { if (!isFinite(p[i])) { throw new Error('lineProfile() takes a frame and the two ends of a line: x1, y1, x2, y2 (or a line of take.sensors).'); } }
    p = fractionsToPixels(p);
    var steps = Math.max(1, Math.round(Math.max(Math.abs(p[2] - p[0]), Math.abs(p[3] - p[1]))));
    var xs = [], ys = [], vs = [], points = [];
    for (var k = 0; k <= steps; k++) {
      var fx = p[0] + (p[2] - p[0]) * k / steps, fy = p[1] + (p[3] - p[1]) * k / steps;
      var x = Math.max(0, Math.min(W - 1, Math.round(fx))), y = Math.max(0, Math.min(H - 1, Math.round(fy)));
      xs.push(x); ys.push(y); vs.push(frame[y * W + x]);
      points.push({x: x, y: y, value: frame[y * W + x]});
    }
    points.x = xs; points.y = ys; points.value = vs;
    return points;
  }
  // fn(frame, i, t) over the frames of a take; the results as one array a key.
  // from, to and every are seconds, like frameAt and the measure tool's
  // from..to (10-16, p2fcc5ca6 and p96ff65f9: {from: 8, to: 16, every: 1}
  // written as seconds was read as frames 8..16 and gave two rows at 1.6
  // and 2.6 s, without a word); step is a number of frames.
  function series(fn, opts) {
    if (typeof fn !== 'function') { return Promise.reject(new Error('series() takes a function (frame, i, t) => value and options {take, from, to, step, every}.')); }
    opts = opts || {};
    var tk = opts.take == null ? runTakes[0] : (typeof opts.take === 'number' ? runTakes[opts.take] : opts.take);
    if (!tk || typeof tk.celsius !== 'function') { return Promise.reject(new Error('series(): take must be one of the takes (or its index in takes).')); }
    var last = Math.max(0, tk.frameCount - 1);
    if ((opts.from != null && !isNum(Number(opts.from))) || (opts.to != null && !isNum(Number(opts.to)))) { return Promise.reject(new Error('series(): from and to are seconds from the start of the take.')); }
    var from = opts.from == null ? 0 : tk.frameAt(Number(opts.from)), to = opts.to == null ? last : tk.frameAt(Number(opts.to));
    from = Math.max(0, Math.min(last, from)); to = Math.max(0, Math.min(last, to));
    if (to < from) { var sw = from; from = to; to = sw; }
    var step = 1;
    if (opts.every != null) {
      var spf = tk.secondsPerFrame > 0 ? tk.secondsPerFrame : (tk.times.length > 1 ? (tk.times[tk.times.length - 1] - tk.times[0]) / (tk.times.length - 1) : 1);
      step = Math.round(Number(opts.every) / spf);
    } else if (opts.step != null) { step = Math.round(Number(opts.step)); }
    if (!isFinite(step)) { return Promise.reject(new Error('series(): step is a number of frames, every a number of seconds.')); }
    step = Math.max(1, step);
    var idx = [], ts = [], results = [];
    var i = from;
    function next() {
      if (i > to) { return Promise.resolve(); }
      var at = i;
      i += step;
      return tk.celsius(at).then(function (frame) { return fn(frame, at, tk.timeOf(at)); }).then(function (v) {
        idx.push(at); ts.push(tk.timeOf(at)); results.push(v);
        return next();
      });
    }
    return next().then(function () {
      var out = {i: idx, t: ts};
      var first = null;
      for (var k = 0; k < results.length; k++) {
        var r = results[k];
        if (r != null && typeof r === 'object' && !Array.isArray(r) && !ArrayBuffer.isView(r)) { first = r; break; }
      }
      if (first) {
        for (var key in first) {
          if (key === 'i' || key === 't') { continue; }
          out[key] = results.map(function (r2) { return r2 != null && typeof r2 === 'object' ? r2[key] : NaN; });
        }
      } else {
        out.v = results;
      }
      return out;
    });
  }
  function smooth(values, n) {
    var arr = toArray(values, 'smooth()');
    var half = Math.max(0, Math.floor((Math.round(Number(n)) || 1) / 2)), out = [];
    for (var i = 0; i < arr.length; i++) {
      var s = 0, c = 0;
      for (var k = Math.max(0, i - half); k <= Math.min(arr.length - 1, i + half); k++) { if (isNum(arr[k])) { s += arr[k]; c++; } }
      out.push(c ? s / c : NaN);
    }
    return out;
  }
  function firstTime(t, values, threshold, opts) {
    var ts = toArray(t, 'firstTime()'), vs = toArray(values, 'firstTime()');
    var th = Number(threshold);
    if (!isFinite(th)) { throw new Error('firstTime() takes times, values, a threshold and options {below, from}.'); }
    opts = opts || {};
    var below = !!opts.below, from = opts.from == null ? -Infinity : Number(opts.from);
    for (var i = 0; i < vs.length && i < ts.length; i++) {
      if (ts[i] < from || !isNum(vs[i])) { continue; }
      if (below ? vs[i] <= th : vs[i] >= th) { return {t: ts[i], index: i}; }
    }
    return null;
  }
  function fitLine(x, y) {
    var xs = toArray(x, 'fitLine()'), ys = toArray(y, 'fitLine()');
    var n = 0, sx = 0, sy = 0, m = Math.min(xs.length, ys.length);
    for (var i = 0; i < m; i++) { if (isNum(xs[i]) && isNum(ys[i])) { n++; sx += xs[i]; sy += ys[i]; } }
    if (n < 2) { return {slope: NaN, intercept: NaN, r2: NaN, n: n}; }
    var mx = sx / n, my = sy / n, sxy = 0, sxx = 0, syy = 0;
    for (var k = 0; k < m; k++) {
      if (!isNum(xs[k]) || !isNum(ys[k])) { continue; }
      var dx = xs[k] - mx, dy = ys[k] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    var slope = sxx > 0 ? sxy / sxx : NaN;
    return {slope: slope, intercept: my - slope * mx, r2: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN, n: n};
  }
  // y = yInf + (y0 - yInf) * exp(-(t - t0) / tau): for each tau of a
  // log-spaced search, yInf and y0 by least squares; the tau of least rms
  function fitExp(t, y, opts) {
    var ts = toArray(t, 'fitExp()'), ys = toArray(y, 'fitExp()');
    opts = opts || {};
    var px = [], py = [];
    for (var i = 0; i < Math.min(ts.length, ys.length); i++) { if (isNum(ts[i]) && isNum(ys[i])) { px.push(ts[i]); py.push(ys[i]); } }
    var n = px.length;
    var none = {tau: NaN, y0: NaN, yInf: NaN, t0: NaN, rms: NaN, n: n};
    if (n < 3) { return none; }
    var t0 = opts.t0 == null ? Math.min.apply(null, px) : Number(opts.t0);
    var span = Math.max.apply(null, px) - t0;
    if (!isFinite(t0) || !(span > 0)) { return none; }
    function solve(tau) {
      var a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (var k = 0; k < n; k++) {
        var g = Math.exp(-(px[k] - t0) / tau), f = 1 - g;
        a11 += f * f; a12 += f * g; a22 += g * g; b1 += f * py[k]; b2 += g * py[k];
      }
      var det = a11 * a22 - a12 * a12;
      if (!(Math.abs(det) > 1e-12)) { return null; }
      var yInf = (b1 * a22 - b2 * a12) / det, y0 = (a11 * b2 - a12 * b1) / det, ss = 0;
      for (var m = 0; m < n; m++) {
        var gg = Math.exp(-(px[m] - t0) / tau), e = py[m] - (yInf * (1 - gg) + y0 * gg);
        ss += e * e;
      }
      return {tau: tau, y0: y0, yInf: yInf, t0: t0, rms: Math.sqrt(ss / n), n: n};
    }
    var best = null;
    function search(lo, hi, steps) {
      for (var s = 0; s <= steps; s++) {
        var r = solve(lo * Math.pow(hi / lo, s / steps));
        if (r && (!best || r.rms < best.rms)) { best = r; }
      }
    }
    search(span / 500, span * 50, 160);
    if (best) { search(best.tau / 1.3, best.tau * 1.3, 60); }
    return best || none;
  }
  function mask(frame, test, r) {
    checkFrame(frame, 'mask()');
    var g = region(r, 'mask()'), out = new Uint8Array(N), th = Number(test);
    var fn = typeof test === 'function' ? test : null;
    if (!fn && !isFinite(th)) { throw new Error('mask() takes a frame and a threshold (°C, at or above) or a function (value, x, y) => true or false.'); }
    eachPixel(g, function (x, y) {
      var v = frame[y * W + x];
      if (isNum(v) && (fn ? fn(v, x, y) : v >= th)) { out[y * W + x] = 1; }
    });
    return out;
  }
  function components(m, opts) {
    if (!m || m.length !== N) { throw new Error('components() takes a mask (what mask gives).'); }
    opts = opts || {};
    var minPixels = Math.max(1, Math.round(Number(opts.minPixels)) || 1);
    var frame = opts.frame || null;
    if (frame) { checkFrame(frame, 'components()'); }
    var label = new Int32Array(N), out = [], stack = [];
    for (var s = 0; s < N; s++) {
      if (!m[s] || label[s]) { continue; }
      var id = out.length + 1, n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sx = 0, sy = 0, mx = -Infinity, sum = 0, cnt = 0, hot = null;
      stack.push(s); label[s] = id;
      while (stack.length) {
        var p = stack.pop(), x = p % W, y = (p - x) / W;
        n++; sx += x; sy += y;
        if (x < x0) { x0 = x; }
        if (x > x1) { x1 = x; }
        if (y < y0) { y0 = y; }
        if (y > y1) { y1 = y; }
        if (frame) {
          var v = frame[p];
          if (isNum(v)) { sum += v; cnt++; if (v > mx) { mx = v; hot = {x: x, y: y}; } }
        }
        var nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
        for (var q = 0; q < 4; q++) { var r = nb[q]; if (r >= 0 && m[r] && !label[r]) { label[r] = id; stack.push(r); } }
      }
      if (n < minPixels) { continue; }
      var c = {n: n, box: [x0, y0, x1 + 1, y1 + 1], centroid: {x: sx / n, y: sy / n}};
      if (frame) { c.max = cnt ? mx : NaN; c.mean = cnt ? sum / cnt : NaN; c.hottest = hot; }
      out.push(c);
    }
    out.sort(function (a, b) { return b.n - a.n; });
    return out;
  }
  function fmtCell(v, digits) {
    if (v == null) { return ''; }
    if (typeof v === 'number') { return !isFinite(v) ? String(v) : v.toFixed(digits).replace(/^-(0(\\.0*)?)$/, '$1'); }
    if (typeof v === 'object') { try { return JSON.stringify(v, round3); } catch (e) { return String(v); } }
    return String(v);
  }
  // how many decimals v needs to show, up to digits: 70 needs none, 7.1 one, 70.123 up to digits
  function decimalsNeeded(v, digits) {
    var s = v.toFixed(digits), dot = s.indexOf('.');
    return dot < 0 ? 0 : s.slice(dot + 1).replace(/0+$/, '').length;
  }
  function table(rows, opts) {
    if (!Array.isArray(rows)) { throw new Error('table() takes an array of rows (objects with the same keys, or arrays) and options {digits, columns}.'); }
    opts = opts || {};
    var digits = opts.digits == null ? 2 : Math.max(0, Math.min(6, Math.round(Number(opts.digits)) || 0));
    var cols = Array.isArray(opts.columns) ? opts.columns.map(String) : null;
    var objects = rows.length > 0 && rows[0] != null && typeof rows[0] === 'object' && !Array.isArray(rows[0]) && !ArrayBuffer.isView(rows[0]);
    if (!cols && objects) {
      cols = [];
      rows.forEach(function (r) { if (r && typeof r === 'object') { for (var k in r) { if (cols.indexOf(k) < 0) { cols.push(k); } } } });
    }
    var raw = rows.map(function (r) {
      if (objects) { return cols.map(function (k) { return r == null ? null : r[k]; }); }
      return Array.isArray(r) || ArrayBuffer.isView(r) ? Array.prototype.slice.call(r) : [r];
    });
    // one number of decimals per column, as many as any value in it needs
    // (up to digits): a column of whole numbers prints without any, and a
    // value that happens to be whole, 70 among 69.79s, keeps its column's
    // (it printed as 70 on 2026-10-15, p946703d)
    var dec = [];
    raw.forEach(function (line) { line.forEach(function (v, j) { if (typeof v === 'number' && isFinite(v)) { dec[j] = Math.max(dec[j] || 0, decimalsNeeded(v, digits)); } }); });
    var cells = raw.map(function (line) { return line.map(function (v, j) { return fmtCell(v, dec[j] || 0); }); });
    var lines = cols ? [cols].concat(cells) : cells;
    var width = [];
    lines.forEach(function (line) { line.forEach(function (c, j) { width[j] = Math.max(width[j] || 0, c.length); }); });
    var text = lines.map(function (line, i) {
      return line.map(function (c, j) {
        var pad = new Array(width[j] - c.length + 1).join(' ');
        var right = i > 0 || !cols ? /^-?[0-9.]/.test(c) : false;
        return right ? pad + c : c + pad;
      }).join('  ').replace(/\\s+$/, '');
    });
    return text.join('\\n');
  }
  // ---- a chart: lines (or points) on one pair of axes, light background
  var PLOT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#8e44ad', '#d4a017', '#e0218a', '#5a6b7c', '#17a2b8'];
  function niceTicks(lo, hi, count) {
    var raw = (hi - lo) / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), r = raw / mag;
    var step = (r >= 7 ? 10 : r >= 3 ? 5 : r >= 1.5 ? 2 : 1) * mag;
    var decimals = Math.max(0, -Math.floor(Math.log(step) / Math.LN10 + 1e-9));
    var ticks = [];
    for (var v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) { ticks.push(Number(v.toFixed(decimals))); }
    return {ticks: ticks, decimals: decimals};
  }
  function plot(spec, more) {
    if (!spec || typeof spec !== 'object') { throw new Error('plot() takes {x, series: {name: values}, title, xLabel, yLabel, xRange, yRange, points}, or what series() returned.'); }
    // a list of series first and the options second — plot([{name, x, y,
    // color}, …], {title, …}) — is how the model wrote it (10-16), and
    // reads as the one form: the list is the spec's series
    if (Array.isArray(spec)) { spec = {series: spec}; }
    var o = {};
    for (var k in spec) { o[k] = spec[k]; }
    if (more && typeof more === 'object') { for (var k2 in more) { o[k2] = more[k2]; } }
    var list = [];
    if (Array.isArray(o.series)) {
      o.series.forEach(function (s, j) {
        if (s && typeof s === 'object' && s.y) { list.push({name: s.name == null ? 'series ' + (j + 1) : String(s.name), x: s.x ? toArray(s.x, 'plot()') : null, y: toArray(s.y, 'plot()'), color: s.color}); }
      });
    } else if (o.series && typeof o.series === 'object') {
      for (var name in o.series) { list.push({name: name, x: null, y: toArray(o.series[name], 'plot()'), color: null}); }
    } else if (o.t) {
      // what series() returned: every array of numbers but i and t
      for (var key in o) {
        var arr = o[key];
        if (key === 'i' || key === 't' || !(Array.isArray(arr) || ArrayBuffer.isView(arr)) || arr.length === 0) { continue; }
        var nums = true;
        for (var q = 0; q < arr.length; q++) { if (typeof arr[q] !== 'number') { nums = false; break; } }
        if (nums) { list.push({name: key, x: null, y: toArray(arr, 'plot()'), color: null}); }
      }
      if (o.xLabel == null) { o.xLabel = 's'; }
    }
    if (!list.length) { throw new Error('plot(): nothing to draw. Give series as {name: values} with x, or what series() returned.'); }
    var xs = o.x ? toArray(o.x, 'plot()') : (o.t ? toArray(o.t, 'plot()') : null);
    list.forEach(function (s) { if (!s.x) { s.x = xs || s.y.map(function (_, i) { return i; }); } });
    var xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    list.forEach(function (s) {
      for (var i = 0; i < s.y.length; i++) {
        var x = s.x[i], y = s.y[i];
        if (!isNum(x) || !isNum(y)) { continue; }
        if (x < xlo) { xlo = x; } if (x > xhi) { xhi = x; } if (y < ylo) { ylo = y; } if (y > yhi) { yhi = y; }
      }
    });
    if (!isFinite(xlo)) { xlo = 0; xhi = 1; }
    if (!isFinite(ylo)) { ylo = 0; yhi = 1; }
    if (o.xRange && o.xRange.length === 2) { xlo = Number(o.xRange[0]); xhi = Number(o.xRange[1]); }
    if (o.yRange && o.yRange.length === 2) { ylo = Number(o.yRange[0]); yhi = Number(o.yRange[1]); }
    else { var padY = (yhi - ylo) * 0.05 || 0.5; ylo -= padY; yhi += padY; }
    if (!(xhi > xlo)) { xhi = xlo + 1; }
    if (!(yhi > ylo)) { yhi = ylo + 1; }
    var width = Math.max(300, Math.min(1600, Math.round(Number(o.width)) || 900)), height = Math.max(200, Math.min(1200, Math.round(Number(o.height)) || 520));
    var c = document.createElement('canvas');
    c.width = width; c.height = height;
    var g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height);
    g.font = '14px sans-serif';
    var left = 72, right = 24, bottom = o.xLabel ? 58 : 40;
    var pw = width - left - right;
    // the legend sits in rows above the plot, never over the curves (10-15:
    // a box in the plot's corner hid the end of the topmost curve)
    var legendRows = [];
    if (list.length > 1 || list[0].name !== 'series 1') {
      var row = [], used = 0;
      list.forEach(function (s, j) {
        var wEntry = 18 + 8 + g.measureText(s.name).width + 22;
        if (row.length && used + wEntry > pw) { legendRows.push(row); row = []; used = 0; }
        row.push({s: s, j: j, x: used});
        used += wEntry;
      });
      if (row.length) { legendRows.push(row); }
    }
    var LEGEND_ROW = 20;
    var legendTop = o.title ? 34 : 12;
    var top = legendTop + legendRows.length * LEGEND_ROW + (legendRows.length ? 12 : (o.title ? 14 : 16));
    var ph = height - top - bottom;
    function X(v) { return left + (v - xlo) / (xhi - xlo) * pw; }
    function Y(v) { return top + (yhi - v) / (yhi - ylo) * ph; }
    var xt = niceTicks(xlo, xhi, 8), yt = niceTicks(ylo, yhi, 6);
    g.font = '14px sans-serif'; g.lineWidth = 1; g.strokeStyle = '#e2e4e6'; g.fillStyle = '#4c535a';
    g.textAlign = 'right'; g.textBaseline = 'middle';
    yt.ticks.forEach(function (v) {
      if (v < ylo || v > yhi) { return; }
      var yy = Y(v);
      g.beginPath(); g.moveTo(left, yy); g.lineTo(left + pw, yy); g.stroke();
      g.fillText(v.toFixed(yt.decimals), left - 8, yy);
    });
    g.textAlign = 'center'; g.textBaseline = 'top';
    xt.ticks.forEach(function (v) {
      if (v < xlo || v > xhi) { return; }
      var xx = X(v);
      g.beginPath(); g.moveTo(xx, top); g.lineTo(xx, top + ph); g.stroke();
      g.fillText(v.toFixed(xt.decimals), xx, top + ph + 6);
    });
    g.strokeStyle = '#c3c6c9';
    g.beginPath(); g.moveTo(left, top); g.lineTo(left, top + ph); g.lineTo(left + pw, top + ph); g.stroke();
    g.fillStyle = '#111417';
    if (o.xLabel) { g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(String(o.xLabel), left + pw / 2, height - 8); }
    if (o.yLabel) { g.save(); g.translate(16, top + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(String(o.yLabel), 0, 0); g.restore(); }
    if (o.title) { g.font = 'bold 16px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(String(o.title), left, 10); g.font = '14px sans-serif'; }
    g.save();
    g.beginPath(); g.rect(left, top, pw, ph); g.clip();
    list.forEach(function (s, j) {
      var col = s.color || PLOT_COLORS[j % PLOT_COLORS.length];
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
      var pen = false;
      if (!o.points) { g.beginPath(); }
      for (var i = 0; i < s.y.length; i++) {
        var x = s.x[i], y = s.y[i];
        if (!isNum(x) || !isNum(y)) { pen = false; continue; }
        if (o.points) { g.beginPath(); g.arc(X(x), Y(y), 3, 0, Math.PI * 2); g.fill(); }
        else if (pen) { g.lineTo(X(x), Y(y)); }
        else { g.moveTo(X(x), Y(y)); pen = true; }
      }
      if (!o.points) { g.stroke(); }
    });
    g.restore();
    g.font = '14px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    legendRows.forEach(function (row, r) {
      var ly = legendTop + r * LEGEND_ROW + LEGEND_ROW / 2;
      row.forEach(function (e) {
        var col = e.s.color || PLOT_COLORS[e.j % PLOT_COLORS.length];
        g.fillStyle = col; g.fillRect(left + e.x, ly - 1.5, 18, 3);
        g.fillStyle = '#111417'; g.fillText(e.s.name, left + e.x + 26, ly);
      });
    });
    return c;
  }
`;

/** The sandbox page: a content-security policy that allows nothing from outside, and the runtime. */
export function sandboxHtml(): string {
  const script = RUNTIME.replace('__W__', String(IR_ARRAY_WIDTH))
    .replace('__H__', String(IR_ARRAY_HEIGHT))
    .replace('__PALETTE__', JSON.stringify(ironPalette()))
    .replace('__PRINT_LIMIT__', String(PRINT_LIMIT))
    .replace('__PICTURE_LIMIT__', String(PICTURE_LIMIT))
    .replace('__MAX_EDGE__', String(PICTURE_MAX_EDGE))
    .replace('__CACHE_FRAMES__', String(CACHE_FRAMES))
    .replace('__PREFETCH__', String(FRAME_PREFETCH))
    .replace('__SAVED_LIMIT__', String(SAVED_LIMIT))
    .replace('__DECODER__', FRAME_DECODER_JS)
    // a function, so no "$" in the library is read as a replacement pattern
    .replace('__LIBRARY__', () => LIBRARY);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; img-src data: blob:; style-src \'unsafe-inline\'">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `</head><body><script>${script}</script></body></html>`
  );
}

// ------------------------------------------------- scripts the app injects

const js = (v: unknown) => JSON.stringify(v);

/** Start a run: the code, what it may see of the takes, and the values earlier runs saved (name → JSON). */
export function runScript(runId: string, code: string, takes: TakeMeta[], saved: Record<string, string> = {}): string {
  return `window.__sb && window.__sb.run(${js(runId)}, ${js(code)}, ${js(takes)}, ${js(saved)}); true;`;
}

/** Hand the page a chunk of frames of take `take`: frame `start` (indexed from 0), then every `step`-th after it. */
export function framesScript(take: number, start: number, b64: string, missing: number[], step = 1): string {
  return `window.__sb && window.__sb.frames(${take}, ${start}, "${b64}", ${js(missing)}, ${step}); true;`;
}

/** Answer a request of the page (a frames request once its chunks are in; a visible-light picture as a data URL). */
export function answerScript(id: number, ok: boolean, payload: unknown): string {
  return `window.__sb && window.__sb.answer(${id}, ${ok ? 'true' : 'false'}, ${js(payload ?? null)}); true;`;
}

// -------------------------------------------------- messages the page posts

export type SandboxMessage =
  | {t: 'ready'}
  | {t: 'need'; id: number; what: 'frames'; take: number; from: number; to: number; step: number}
  | {t: 'need'; id: number; what: 'visible'; take: number; i: number}
  | {t: 'print'; runId: string; s: string}
  | {t: 'picture'; runId: string; index: number; caption: string; png: string}
  | {t: 'save'; runId: string; name: string; json: string | null}
  | {t: 'done'; runId: string; ok: boolean; returned: string | null; error: string | null; ms: number; framesRead: number};

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A message the page posted, or null for anything else. */
export function parseSandboxMessage(data: string): SandboxMessage | null {
  let m: Record<string, unknown>;
  try {
    const v = JSON.parse(data);
    if (!v || typeof v !== 'object') {
      return null;
    }
    m = v as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (m.t) {
    case 'ready':
      return {t: 'ready'};
    case 'need': {
      const id = int(m.id);
      const take = int(m.take);
      if (id == null || take == null) {
        return null;
      }
      if (m.what === 'frames') {
        const from = int(m.from);
        const to = int(m.to);
        // the frames from, from + step, … up to to; a step left out or odd is 1
        const step = Math.max(1, int(m.step) ?? 1);
        return from == null || to == null ? null : {t: 'need', id, what: 'frames', take, from, to, step};
      }
      if (m.what === 'visible') {
        const i = int(m.i);
        return i == null ? null : {t: 'need', id, what: 'visible', take, i};
      }
      return null;
    }
    case 'print':
      return {t: 'print', runId: str(m.runId), s: str(m.s)};
    case 'picture': {
      const index = int(m.index);
      return index == null || !str(m.png)
        ? null
        : {t: 'picture', runId: str(m.runId), index, caption: str(m.caption), png: str(m.png)};
    }
    case 'save':
      return !str(m.name) || (m.json != null && typeof m.json !== 'string')
        ? null
        : {t: 'save', runId: str(m.runId), name: str(m.name), json: typeof m.json === 'string' ? m.json : null};
    case 'done':
      return {
        t: 'done',
        runId: str(m.runId),
        ok: m.ok === true,
        returned: typeof m.returned === 'string' ? m.returned : null,
        error: typeof m.error === 'string' ? m.error : null,
        ms: int(m.ms) ?? 0,
        framesRead: int(m.framesRead) ?? 0,
      };
    default:
      return null;
  }
}
