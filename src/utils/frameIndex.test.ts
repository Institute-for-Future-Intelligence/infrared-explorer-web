import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_INDEX_FILE, frameScaleOf, parseFrameIndex, parseFrameIndexBytes } from './frameIndex';

const file = {
  version: 1,
  timing: 'camera',
  frameCount: 4,
  frameCaptureMs: [37, 152, 270, 1660],
  frameScaleMin: [20.5, 20.4, null, 20.1],
  frameScaleMax: [31.2, 31.3, 31.1, 20.1],
};

describe('parseFrameIndex', () => {
  it('reads the capture times and the scale of every frame', () => {
    const index = parseFrameIndex(file);
    assert.ok(index);
    assert.equal(index.frameCount, 4);
    assert.deepEqual(index.captureMs, [37, 152, 270, 1660]);
    assert.deepEqual(index.scaleMin, [20.5, 20.4, null, 20.1]);
    assert.deepEqual(index.scaleMax, [31.2, 31.3, 31.1, 20.1]);
  });

  it('is null for anything that carries no capture times', () => {
    assert.equal(parseFrameIndex(null), null);
    assert.equal(parseFrameIndex('frames'), null);
    assert.equal(parseFrameIndex({}), null);
    assert.equal(parseFrameIndex({ frameCaptureMs: [] }), null);
    assert.equal(parseFrameIndex({ frameCaptureMs: 'no' }), null);
    // A frame without a time cannot be placed, so the index places none.
    assert.equal(parseFrameIndex({ frameCaptureMs: [0, null, 240] }), null);
    assert.equal(parseFrameIndex({ frameCaptureMs: [0, NaN] }), null);
  });

  it('takes the shorter of the declared count and the list', () => {
    assert.equal(parseFrameIndex({ ...file, frameCount: 3 })?.frameCount, 3);
    assert.deepEqual(parseFrameIndex({ ...file, frameCount: 3 })?.captureMs, [37, 152, 270]);
    assert.equal(parseFrameIndex({ ...file, frameCount: 9 })?.frameCount, 4);
    assert.equal(parseFrameIndex({ frameCaptureMs: [0, 120] })?.frameCount, 2);
    assert.equal(parseFrameIndex({ frameCaptureMs: [0, 120], frameCount: 0 })?.frameCount, 2);
  });

  it('never lets a time run backwards', () => {
    assert.deepEqual(parseFrameIndex({ frameCaptureMs: [10, 130, 129, 250] })?.captureMs, [10, 130, 130, 250]);
  });

  it('reads a missing or malformed scale as null, entry by entry', () => {
    const index = parseFrameIndex({ frameCaptureMs: [0, 120, 240], frameScaleMin: [20, 'x'], frameScaleMax: 5 });
    assert.deepEqual(index?.scaleMin, [20, null, null]);
    assert.deepEqual(index?.scaleMax, [null, null, null]);
  });
});

describe('parseFrameIndexBytes', () => {
  it('parses the file as it is stored (UTF-8 JSON bytes)', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    assert.deepEqual(parseFrameIndexBytes(bytes)?.captureMs, file.frameCaptureMs);
    assert.deepEqual(parseFrameIndexBytes(bytes.buffer as ArrayBuffer)?.captureMs, file.frameCaptureMs);
  });

  it('is null for bytes that are not the file', () => {
    assert.equal(parseFrameIndexBytes(new TextEncoder().encode('<html>404</html>')), null);
    assert.equal(parseFrameIndexBytes(new Uint8Array(0)), null);
  });
});

describe('frameScaleOf', () => {
  const index = parseFrameIndex(file);

  it('is the range the camera coloured a recording frame over (1-based)', () => {
    assert.deepEqual(frameScaleOf(index, 1), { min: 20.5, max: 31.2 });
    assert.deepEqual(frameScaleOf(index, 2), { min: 20.4, max: 31.3 });
  });

  it('is null where the take recorded none, or a range with no span, or there is no index', () => {
    assert.equal(frameScaleOf(index, 3), null); // min is null
    assert.equal(frameScaleOf(index, 4), null); // max == min
    assert.equal(frameScaleOf(index, 0), null);
    assert.equal(frameScaleOf(index, 5), null);
    assert.equal(frameScaleOf(null, 1), null);
    assert.equal(frameScaleOf(undefined, 1), null);
  });
});

describe('FRAME_INDEX_FILE', () => {
  it("is the capture app's file name", () => {
    assert.equal(FRAME_INDEX_FILE, 'frame-index.bin');
  });
});
