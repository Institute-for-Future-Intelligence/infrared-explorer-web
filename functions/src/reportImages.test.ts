/**
 * Tests for reportImages.ts — the pictures a report shows the model, made the same way for an uploaded
 * recording as the phone makes them for a container.
 *
 * The frame rules (posePhotoFrames / contactSheetFrames / sheetLabel) are the app's aiReportPack.ts
 * verbatim, so their cases here are the app's cases (__tests__/aiReportPack.test.ts) — a change on
 * one side that is not made on the other fails one suite. The pixel work is checked on synthetic
 * pictures: a resize must average what it covers, a cap must leave a small photo's bytes alone and
 * shrink a large one, a shrink-on-load decode must land inside its box, and a sheet must be the size
 * the tile grid says with its labels drawn.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contactSheetFrames,
  contactSheetJpeg,
  contactSheetRgba,
  decodeJpegFit,
  decodeJpegRgba,
  encodeRgbaJpeg,
  fitWithin,
  jpegDimensions,
  labelForSeconds,
  POOL_PHOTO_LONG_EDGE,
  posePhotoFrames,
  resizeRgba,
  scaledJpeg,
  SHEET_COLUMNS,
  SHEET_TILE_H,
  SHEET_TILE_W,
  SHEET_TILES_MAX,
  sheetLabel,
  type Rgba,
} from './reportImages';

/** A solid-colour picture. */
function solid(width: number, height: number, rgb: [number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function pixel(img: Rgba, x: number, y: number): [number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

function near(a: [number, number, number], b: [number, number, number], tol = 8): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

describe('posePhotoFrames', () => {
  it('takes the middle of each pose plus the first and last selected frames', () => {
    const frames = posePhotoFrames(
      {
        poses: [
          { from: 1, to: 100 },
          { from: 110, to: 200 },
        ],
      },
      [1, 26, 51, 200],
    );
    assert.deepEqual(frames, [1, 50, 155, 200]);
  });
});

describe('contactSheetFrames', () => {
  it('keeps every selected frame when they fit', () => {
    assert.deepEqual(contactSheetFrames([1, 5, 9]), [1, 5, 9]);
  });
  it('spreads evenly, ends included, when there are more than the tiles', () => {
    const picked = Array.from({ length: 120 }, (_, i) => i * 3 + 1);
    const tiles = contactSheetFrames(picked);
    assert.equal(tiles.length, SHEET_TILES_MAX);
    assert.equal(tiles[0], 1);
    assert.equal(tiles[tiles.length - 1], picked[picked.length - 1]);
    for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i] > tiles[i - 1]);
  });
});

describe('sheetLabel', () => {
  it('labels seconds, then minutes past 100 s', () => {
    assert.equal(sheetLabel(1, 5), '0s');
    assert.equal(sheetLabel(241, 5), '48s');
    assert.equal(sheetLabel(601, 5), '2m');
    assert.equal(sheetLabel(626, 5), '2m5s');
  });
  it('is the same label from seconds, which is what the server has for a stored frame', () => {
    assert.equal(labelForSeconds(48.0), '48s');
    assert.equal(labelForSeconds(120), '2m');
    assert.equal(labelForSeconds(125.2), '2m5s');
  });
});

describe('resizeRgba', () => {
  it('averages what each destination pixel covers when shrinking', () => {
    // Left half red, right half blue → one pixel wide = purple.
    const src = solid(4, 2, [255, 0, 0]);
    for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) src.data.set([0, 0, 255, 255], (y * 4 + x) * 4);
    const out = resizeRgba(src, 1, 1);
    assert.deepEqual(pixel(out, 0, 0), [128, 0, 128]);
    const halves = resizeRgba(src, 2, 1);
    assert.deepEqual(pixel(halves, 0, 0), [255, 0, 0]);
    assert.deepEqual(pixel(halves, 1, 0), [0, 0, 255]);
  });
  it('keeps a solid colour solid when enlarging', () => {
    const out = resizeRgba(solid(2, 2, [10, 200, 30]), 5, 7);
    assert.equal(out.width, 5);
    assert.equal(out.height, 7);
    assert.deepEqual(pixel(out, 4, 6), [10, 200, 30]);
  });
});

describe('fitWithin', () => {
  it('never enlarges and keeps the aspect ratio when it shrinks', () => {
    assert.deepEqual(fitWithin(300, 200, 320), { w: 300, h: 200 });
    assert.deepEqual(fitWithin(1440, 1080, 320), { w: 320, h: 240 });
    assert.deepEqual(fitWithin(1080, 1440, 640), { w: 480, h: 640 });
  });
});

describe('scaledJpeg', () => {
  it('reads a JPEG’s size from its header and leaves a small one’s bytes untouched', async () => {
    const small = await encodeRgbaJpeg(solid(300, 200, [40, 80, 120]), 75);
    assert.deepEqual(jpegDimensions(small), { width: 300, height: 200 });
    assert.equal(await scaledJpeg(small, POOL_PHOTO_LONG_EDGE), small);
  });
  it('shrinks a large one to the cap and keeps its colour', async () => {
    const large = await encodeRgbaJpeg(solid(1080, 1440, [200, 100, 50]), 75);
    const capped = await scaledJpeg(large, POOL_PHOTO_LONG_EDGE);
    assert.ok(capped && capped !== large);
    assert.deepEqual(jpegDimensions(capped!), { width: 240, height: 320 });
    assert.ok(near(pixel((await decodeJpegRgba(capped!))!, 120, 160), [200, 100, 50]));
  });
  it('answers null for bytes that are not a picture', async () => {
    assert.equal(jpegDimensions(new Uint8Array([1, 2, 3, 4, 5])), null);
    assert.equal(await scaledJpeg(new Uint8Array([1, 2, 3, 4, 5]), 320), null);
    assert.equal(await decodeJpegFit(new Uint8Array([1, 2, 3, 4, 5]), 120, 160), null);
  });
});

describe('decodeJpegFit', () => {
  it('lands inside the box, aspect kept, and never enlarges', async () => {
    const portrait = await encodeRgbaJpeg(solid(1080, 1440, [0, 160, 0]), 75);
    const tile = (await decodeJpegFit(portrait, SHEET_TILE_W, SHEET_TILE_H))!;
    assert.deepEqual([tile.width, tile.height], [120, 160]);
    assert.ok(near(pixel(tile, 60, 80), [0, 160, 0]));
    const tiny = await encodeRgbaJpeg(solid(40, 30, [0, 0, 160]), 75);
    const same = (await decodeJpegFit(tiny, SHEET_TILE_W, SHEET_TILE_H))!;
    assert.deepEqual([same.width, same.height], [40, 30]);
  });
});

describe('contactSheetRgba', () => {
  it('lays the tiles out in the grid, fitted and centred, with a label box at each top-left', () => {
    const tiles = Array.from({ length: 8 }, (_, i) => ({ picture: solid(400, 300, [0, 160, 0]), label: `${i * 5}s` }));
    const sheet = contactSheetRgba(tiles);
    assert.ok(sheet);
    assert.equal(sheet!.width, SHEET_COLUMNS * SHEET_TILE_W);
    assert.equal(sheet!.height, 2 * SHEET_TILE_H);
    // A 4:3 picture in a 120 × 160 tile is 120 × 90, centred: green at the tile's middle, black above.
    assert.deepEqual(pixel(sheet!, 60, 80), [0, 160, 0]);
    assert.deepEqual(pixel(sheet!, 60, 20), [0, 0, 0]);
    // The second row's second tile is tile 7; the empty slots after it stay black.
    assert.deepEqual(pixel(sheet!, SHEET_TILE_W + 60, SHEET_TILE_H + 80), [0, 160, 0]);
    assert.deepEqual(pixel(sheet!, 3 * SHEET_TILE_W + 60, SHEET_TILE_H + 80), [0, 0, 0]);
    // The label is white glyphs on a darkened box.
    let white = 0;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) if (pixel(sheet!, x, y)[0] === 255) white += 1;
    assert.ok(white > 10);
  });
  it('is nothing when no tile has a picture, and a JPEG the grid’s size otherwise', async () => {
    assert.equal(contactSheetRgba([{ picture: null, label: '0s' }]), null);
    assert.equal(await contactSheetJpeg([{ picture: null, label: '0s' }]), null);
    const jpeg = await contactSheetJpeg([{ picture: solid(120, 90, [90, 90, 90]), label: '0s' }]);
    assert.deepEqual(jpegDimensions(jpeg!), { width: SHEET_COLUMNS * SHEET_TILE_W, height: SHEET_TILE_H });
  });
});
