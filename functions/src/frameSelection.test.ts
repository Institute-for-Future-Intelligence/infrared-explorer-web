/**
 * Golden tests for the shared frame-selection module.
 *
 * MIRRORED: this file's golden recording and expected output exist identically in the app repository
 * (infrared-explorer-app/__tests__/frameSelection.test.ts, Jest) — the module runs on the phone to
 * choose a local recording's frames and on the server to choose an uploaded one's, and the two must
 * agree frame for frame. Change the golden here and there in the same change.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKS,
  blockMeansCentiKelvin,
  detectCamera,
  encodeFrameStats,
  FRAME_H,
  FRAME_STATS_FRAME_BYTES,
  FRAME_STATS_HEADER_BYTES,
  FRAME_W,
  frameAvailable,
  frameStatsFingerprint,
  parseFrameStats,
  selectFrames,
} from './frameSelection';

/**
 * The golden recording: 60 s at 5 fps. A textured bench near 22 °C; a mug (x 40..69, y 60..89) poured
 * at t = 10 s, heating to 60 °C by t = 14 s, then cooling with tau = 20 s; a shutter step of +0.3 °C from
 * frame 151; the camera pans right one block per frame over frames 201..205; a hand across the top half
 * at frames 261..266. Built from pixel grids through blockMeansCentiKelvin, as the recorder does.
 */
function goldenFrames(): Uint16Array[] {
  const FPS = 5;
  const N = 300;
  const frames: Uint16Array[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / FPS;
    const grid = new Float64Array(FRAME_W * FRAME_H);
    const nuc = i >= 150 ? 0.3 : 0;
    const pan = i >= 200 && i < 205 ? (i - 199) * 10 : i >= 205 ? 50 : 0;
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        const sx = x + pan;
        let c = 22 + 1.5 * Math.sin(sx * 0.25) + 0.8 * Math.cos(y * 0.17) + 0.3 * Math.sin((sx + y) * 0.9);
        const inMug = sx >= 40 && sx < 70 && y >= 60 && y < 90;
        if (inMug) {
          if (t >= 10 && t < 14) c = 22 + ((t - 10) / 4) * 38;
          else if (t >= 14) c = 22 + 38 * Math.exp(-(t - 14) / 20);
        }
        if (i >= 260 && i <= 265 && y < FRAME_H / 2) c = 33;
        grid[y * FRAME_W + x] = Math.round((c + nuc + 273.15) * 100);
      }
    }
    frames.push(blockMeansCentiKelvin(grid));
  }
  return frames;
}

/** Pinned output — the same strings sit in the app's copy of this test. */
const GOLDEN_CAMERA =
  '{"poses":[{"from":1,"to":199},{"from":206,"to":300}],"moves":[{"from":200,"to":205,"shiftBlocks":1}],"nuc":[151]}';
const GOLDEN_PICKED = '1,26,51,52,71,72,73,77,95,109,128,147,151,176,201,206,207,230,249,261,262,267,268,293,300';
const GOLDEN_REASONS = '{"edge":2,"kink":16,"backbone":4,"extreme":1,"annotation":1,"nuc":1}';
const GOLDEN_SOFTCAP_20 = '1,26,51,66,71,84,109,134,151,176,201,226,251,261,276,300';

describe('frame-stats sidecar', () => {
  it('round-trips through the binary format', () => {
    const frames = goldenFrames();
    const bytes = encodeFrameStats(frames);
    assert.equal(bytes.length, FRAME_STATS_HEADER_BYTES + frames.length * FRAME_STATS_FRAME_BYTES);
    const file = parseFrameStats(bytes)!;
    assert.ok(file);
    assert.equal(file.frameCount, 300);
    for (let f = 0; f < frames.length; f++) {
      for (let b = 0; b < BLOCKS; b++) assert.equal(file.means[f * BLOCKS + b], frames[f][b]);
    }
  });

  it('keeps the frames a short (interrupted) file holds, and rejects what is not a sidecar', () => {
    const bytes = encodeFrameStats(goldenFrames());
    const cut = bytes.slice(0, FRAME_STATS_HEADER_BYTES + 10 * FRAME_STATS_FRAME_BYTES + 7);
    assert.equal(parseFrameStats(cut)!.frameCount, 10);
    assert.equal(parseFrameStats(new Uint8Array(8)), null);
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 0x58;
    assert.equal(parseFrameStats(wrongMagic), null);
  });

  it('treats an all-zero frame as unavailable', () => {
    const frames = goldenFrames();
    frames[5] = new Uint16Array(BLOCKS);
    const file = parseFrameStats(encodeFrameStats(frames))!;
    assert.equal(frameAvailable(file, 5), false);
    assert.equal(frameAvailable(file, 6), true);
    assert.equal(frameAvailable(file, 300), false);
  });

  it('block means are the frame quantisation of the 10 x 10 pixel average', () => {
    const grid = new Float64Array(FRAME_W * FRAME_H).fill(29515); // 22.00 °C
    grid[0] = 29615; // one pixel a degree warmer: the block's mean rises by 0.01 °C
    const means = blockMeansCentiKelvin(grid);
    assert.equal(means[0], 29516);
    assert.equal(means[1], 29515);
    assert.equal(means.length, BLOCKS);
  });

  it('fingerprints the bytes', () => {
    const a = frameStatsFingerprint(encodeFrameStats(goldenFrames()));
    const frames = goldenFrames();
    frames[0][0] += 1;
    const b = frameStatsFingerprint(encodeFrameStats(frames));
    assert.notEqual(a, b);
    assert.match(a, /^\d+-[0-9a-f]{8}$/);
  });
});

describe('selectFrames (golden)', () => {
  const file = parseFrameStats(encodeFrameStats(goldenFrames()))!;

  it('finds the pan, the shutter step, and not the hand', () => {
    assert.equal(JSON.stringify(detectCamera(file)), GOLDEN_CAMERA);
  });

  it('does not take the picture wobbling for a shutter step', () => {
    // The golden bench with the whole picture shifted by ±0.15 °C on alternate frames — what a
    // FLIR ONE does a third of the time between calibrations — and one +0.4 °C frame at 60 that goes
    // straight back. Uniform enough to pass the spread test; neither is a step because neither HOLDS.
    const frames: Uint16Array[] = [];
    for (let i = 0; i < 100; i++) {
      const grid = new Float64Array(FRAME_W * FRAME_H);
      const wobble = (i % 2 ? 0.15 : -0.15) + (i === 60 ? 0.4 : 0);
      for (let y = 0; y < FRAME_H; y++) {
        for (let x = 0; x < FRAME_W; x++) {
          const c = 22 + 1.5 * Math.sin(x * 0.25) + 0.8 * Math.cos(y * 0.17) + 0.3 * Math.sin((x + y) * 0.9);
          grid[y * FRAME_W + x] = Math.round((c + wobble + 273.15) * 100);
        }
      }
      frames.push(blockMeansCentiKelvin(grid));
    }
    const wobbly = detectCamera(parseFrameStats(encodeFrameStats(frames))!);
    assert.deepEqual(wobbly.nuc, []);
    assert.deepEqual(wobbly.moves, []);
  });

  it('does not take an object set down in the picture for a camera move', () => {
    // The golden bench alone, with a 30 x 40 px block at 60 °C sliding up from the bottom edge over
    // frames 100..103 and then standing — a mug being placed. Its advancing edge is "explained" by a
    // grid shift as well as a pan is; what tells them apart is how little of the grid changed.
    const frames: Uint16Array[] = [];
    for (let i = 0; i < 150; i++) {
      const grid = new Float64Array(FRAME_W * FRAME_H);
      const top = i < 100 ? FRAME_H : Math.max(FRAME_H - 40, FRAME_H - 10 * (i - 99));
      for (let y = 0; y < FRAME_H; y++) {
        for (let x = 0; x < FRAME_W; x++) {
          let c = 22 + 1.5 * Math.sin(x * 0.25) + 0.8 * Math.cos(y * 0.17) + 0.3 * Math.sin((x + y) * 0.9);
          if (x >= 40 && x < 70 && y >= top) c = 60;
          grid[y * FRAME_W + x] = Math.round((c + 273.15) * 100);
        }
      }
      frames.push(blockMeansCentiKelvin(grid));
    }
    const placed = detectCamera(parseFrameStats(encodeFrameStats(frames))!);
    assert.deepEqual(placed.moves, []);
    assert.deepEqual(placed.poses, [{ from: 1, to: 150 }]);
  });

  it('picks the pinned frames', () => {
    const sel = selectFrames(file, { secondPerFrame: 0.2, keepFrames: [77] });
    assert.equal(sel.picked.join(','), GOLDEN_PICKED);
    assert.equal(JSON.stringify(sel.reasons), GOLDEN_REASONS);
    assert.equal(sel.deltaMultiplier, 1);
    assert.equal(sel.algo, 'pe1');
  });

  it('is dense through the pour and sparse along the cooling curve', () => {
    const sel = selectFrames(file, { secondPerFrame: 0.2 });
    const picked = new Set(sel.picked);
    // The pour (frames 51..70) is where the extrapolation fails; the cooling (71..150) is predictable.
    assert.ok(picked.has(51) && picked.has(52), 'the onset is kept frame by frame');
    const cooling = sel.picked.filter((f) => f > 73 && f <= 150).length;
    assert.ok(cooling >= 3 && cooling <= 8, `cooling kept ${cooling} frames`);
    // A plateau is still sampled at the backbone rate (5 s = 25 frames).
    for (let i = 1; i < sel.picked.length; i++) assert.ok(sel.picked[i] - sel.picked[i - 1] <= 25);
  });

  it('honours the soft cap by widening the thresholds', () => {
    const sel = selectFrames(file, { secondPerFrame: 0.2, softCap: 20 });
    assert.ok(sel.picked.length <= 20);
    assert.ok(sel.deltaMultiplier > 1);
    assert.equal(sel.picked.join(','), GOLDEN_SOFTCAP_20);
  });

  it('keeps the first and last frames even when nothing happens', () => {
    const flat = Array.from({ length: 50 }, () => new Uint16Array(BLOCKS).fill(29515));
    const sel = selectFrames(parseFrameStats(encodeFrameStats(flat))!, { secondPerFrame: 0.2 });
    assert.deepEqual(sel.picked, [1, 26, 50]);
    assert.deepEqual(detectCamera(parseFrameStats(encodeFrameStats(flat))!).moves, []);
  });

  it('skips unavailable frames and survives an empty file', () => {
    const frames = goldenFrames();
    frames[0] = new Uint16Array(BLOCKS);
    const sel = selectFrames(parseFrameStats(encodeFrameStats(frames))!, { secondPerFrame: 0.2 });
    assert.equal(sel.picked[0], 2);
    assert.deepEqual(selectFrames(parseFrameStats(encodeFrameStats([]))!, { secondPerFrame: 0.2 }).picked, []);
  });
});
