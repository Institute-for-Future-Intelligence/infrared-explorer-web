import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleLuma } from '../../functions/src/twinOrbit';
import type { TwinStability } from '../types';
import { stabilitySampleIndices } from './twinStability';
import {
  VISIBLE_CHECK_FRAMES,
  assessVisibleMotion,
  cameraMotionKind,
  neighbourIndex,
  visibleCheckIndices,
} from './twinCameraMotion';

const W = 240;
const H = 320;

/**
 * The visible photo of a kettle on a bench, as the camera sees it from azimuth `theta` (radians): the
 * kettle and the bench are centred from every side, the room behind them — a 360° panorama four pictures
 * wide — sweeps past as the camera walks. `jitter` nudges the whole picture by thermal px (two photo px),
 * as a hand does; `hand` puts an arm across the lower right of the picture.
 */
function photo(theta: number, jitter: [number, number] = [0, 0], hand = false): Float32Array {
  const data = new Float32Array(W * H);
  const panorama = 4 * W;
  const pan = (theta / (2 * Math.PI)) * panorama;
  const props = Array.from({ length: 40 }, (_, k) => ({
    x: (((((k * 211) % panorama) - pan) % panorama) + panorama) % panorama,
    y: 20 + ((k * 71) % 150),
    w: 14 + ((k * 13) % 30),
    h: 20 + ((k * 29) % 70),
    v: 140 + ((k * 47) % 100),
  }));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x - jitter[0] * 2;
      const gy = y - jitter[1] * 2;
      let v = 90;
      for (const p of props) {
        if ((gx >= p.x && gx < p.x + p.w) || (gx >= p.x - panorama && gx < p.x - panorama + p.w)) {
          if (gy >= p.y && gy < p.y + p.h) v = p.v;
        }
      }
      if (gy > 236) v = 60; // the bench
      if (Math.hypot(gx - 120, gy - 208) < 36) v = 30; // the hot plate
      if (gx > 88 && gx < 152 && gy > 104 && gy < 200) v = 200; // the kettle body
      if (hand && x > 150 && y > 170 && y < 230) v = 170; // an arm reaching in from the right
      data[y * W + x] = v;
    }
  }
  return visibleLuma({ data, width: W, height: H });
}

/** A photo of a dark room: sensor noise, different in every frame. */
function darkPhoto(seed: number): Float32Array {
  const data = new Float32Array(W * H);
  let s = seed * 2654435761;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 374761393) | 0;
    data[i] = 8 + ((s >>> 8) % 1000) / 250;
  }
  return visibleLuma({ data, width: W, height: H });
}

const stability = (stable: boolean): TwinStability => ({
  stable,
  maxShiftPx: stable ? 2 : 20,
  p95ShiftPx: stable ? 1 : 18,
  sampled: 60,
  referenceIndex: 30,
});

describe('visibleCheckIndices / neighbourIndex', () => {
  it('takes every other sample of a short clip and spreads the cap over a long one, off its ends', () => {
    assert.deepEqual(visibleCheckIndices([1, 2, 3, 4, 5], 3), [1, 2, 4, 5]);
    const sampled = stabilitySampleIndices(600);
    const picked = visibleCheckIndices(sampled, sampled[60]);
    assert.equal(picked.length, VISIBLE_CHECK_FRAMES);
    assert.ok(!picked.includes(sampled[60]));
    assert.ok(picked[0] > sampled[0] && picked[picked.length - 1] < sampled[sampled.length - 1]);
    assert.deepEqual(
      picked,
      [...picked].sort((a, b) => a - b),
    );
    assert.equal(new Set(picked).size, picked.length);
  });

  it('names the frame next to the reference', () => {
    assert.equal(neighbourIndex(30, 120), 31);
    assert.equal(neighbourIndex(120, 120), 119);
    assert.equal(neighbourIndex(1, 1), null);
  });
});

describe('assessVisibleMotion / cameraMotionKind', () => {
  const reference = photo(0);
  const neighbour = photo(0, [1, 0]);

  it('reads a hand-held clip from one standpoint as a fixed camera', () => {
    const jitters: [number, number][] = [
      [0, 1],
      [2, 0],
      [-1, 2],
      [3, -1],
      [0, 0],
      [-2, -2],
    ];
    const visible = assessVisibleMotion(
      reference,
      neighbour,
      jitters.map((j) => photo(0, j)),
    );
    assert.deepEqual(visible, { compared: 6, moved: 0 });
    assert.equal(cameraMotionKind(stability(true), visible), 'fixed');
  });

  it('reads a walk around a subject whose thermal picture never changes as a walk-around', () => {
    // The reference is the stillest frame, part-way round; the others are spread over the walk.
    const others = [-0.4, -0.25, -0.1, 0.02, 0.15, 0.3, 0.45].map((turn) => photo(turn * 2 * Math.PI));
    const visible = assessVisibleMotion(reference, neighbour, others);
    assert.ok(visible && visible.moved >= 5, JSON.stringify(visible));
    assert.equal(cameraMotionKind(stability(true), visible), 'orbit');
  });

  it('keeps a fixed camera fixed when a hand reaches into a few of its frames', () => {
    const others = [false, true, true, false, false, false, false, false].map((hand) => photo(0, [1, 1], hand));
    const visible = assessVisibleMotion(reference, neighbour, others);
    assert.ok(visible && visible.compared === 8 && visible.moved <= 2, JSON.stringify(visible));
    assert.equal(cameraMotionKind(stability(true), visible), 'fixed');
  });

  it('says nothing when the photos are too dark to compare, or too few', () => {
    const dark = Array.from({ length: 8 }, (_, k) => darkPhoto(k + 3));
    assert.equal(assessVisibleMotion(darkPhoto(1), darkPhoto(2), dark), null);
    assert.equal(assessVisibleMotion(reference, neighbour, [photo(0), null, photo(1)]), null);
    assert.equal(assessVisibleMotion(null, neighbour, [photo(0), photo(0), photo(0)]), null);
    assert.equal(assessVisibleMotion(reference, null, [photo(0), photo(0), photo(0)]), null);
    assert.equal(cameraMotionKind(stability(true), null), 'fixed');
  });

  it('lets the thermal gate decide alone when the frames drift, and needs most photos to overrule it', () => {
    assert.equal(cameraMotionKind(stability(false), null), 'orbit');
    assert.equal(cameraMotionKind(stability(false), { compared: 8, moved: 0 }), 'orbit');
    assert.equal(cameraMotionKind(stability(true), { compared: 8, moved: 4 }), 'fixed');
    assert.equal(cameraMotionKind(stability(true), { compared: 8, moved: 5 }), 'orbit');
  });
});
