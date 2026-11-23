import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_ADJUST, PictureAdjust } from './core/pictureAdjustParams';
import {
  PICTURE_ADJUST_DOC_VERSION,
  adjustFieldsOf,
  anyAdjusted,
  experimentAdjusts,
  frameAdjust,
  photoAdjusts,
  recordingAdjusts,
} from './doc';

const set = (over: Partial<PictureAdjust>): PictureAdjust => ({ ...NO_ADJUST, ...over });
const V = PICTURE_ADJUST_DOC_VERSION;

describe('a recording’s Process settings, read off its document', () => {
  it('reads each processed view, effects in their order', () => {
    const ir = set({
      contrast: 20,
      effects: [
        { effect: 'posterize', amount: 60 },
        { effect: 'edge', amount: 50 },
      ],
    });
    const views = recordingAdjusts({ version: V, views: { ir, visible: set({ brightness: 30 }) } });
    assert.deepEqual(views, { ir, visible: set({ brightness: 30 }) });
    assert.deepEqual(
      views?.ir?.effects?.map((s) => s.effect),
      ['posterize', 'edge'],
    );
  });

  it('is nothing for a document without them, or with nothing processed', () => {
    assert.equal(recordingAdjusts(undefined), null);
    assert.equal(recordingAdjusts(null), null);
    assert.equal(recordingAdjusts('junk'), null);
    assert.equal(recordingAdjusts({ version: V }), null);
    assert.equal(recordingAdjusts({ version: V, views: { ir: { ...NO_ADJUST } } }), null);
  });

  it('does not guess at a shape it does not know: the capture is shown as made', () => {
    const views = { ir: set({ hue: 10 }) };
    assert.equal(recordingAdjusts({ version: V + 1, views }), null);
    assert.equal(recordingAdjusts({ views }), null);
    assert.equal(recordingAdjusts({ version: '1', views }), null);
  });

  it('trusts what the app would: sliders clamped to their travel, unknown effects and views dropped', () => {
    const views = recordingAdjusts({
      version: V,
      views: {
        ir: { brightness: 500, contrast: 12.4, nonsense: true, effects: [{ effect: 'nope', amount: 9 }] },
        panorama: set({ brightness: 10 }),
      },
    });
    assert.deepEqual(views, { ir: set({ brightness: 100, contrast: 12 }) });
  });
});

describe('a photo set’s Process settings', () => {
  const second = { ir: set({ saturation: -100 }) };

  it('keeps one entry a photo, in capture order', () => {
    assert.deepEqual(photoAdjusts({ version: V, photos: [null, second, null] }, 3), [null, second, null]);
  });

  it('is nothing when the list does not line up with the photos, or no photo is processed', () => {
    assert.equal(photoAdjusts({ version: V, photos: [second] }, 3), null);
    assert.equal(photoAdjusts({ version: V, photos: [null, null, null] }, 3), null);
    assert.equal(photoAdjusts({ version: V + 1, photos: [null, second, null] }, 3), null);
    assert.equal(photoAdjusts(undefined, 3), null);
  });
});

describe('the settings a frame is drawn with', () => {
  it('a recording’s views are processed whole, whichever frame', () => {
    const all = experimentAdjusts({ pictureAdjust: { version: V, views: { blended: set({ exposure: 10 }) } } }, 0);
    assert.equal(anyAdjusted(all), true);
    assert.deepEqual(frameAdjust(all, 'blended', 0), set({ exposure: 10 }));
    assert.deepEqual(frameAdjust(all, 'blended', 412), set({ exposure: 10 }));
    assert.equal(frameAdjust(all, 'ir', 0), null);
  });

  it('a photo set’s by its capture slot, and only the photo that has them', () => {
    const exp = { photoPictureAdjust: { version: V, photos: [null, { visible: set({ tint: 5 }) }, null] } };
    const all = experimentAdjusts(exp, 3);
    assert.equal(frameAdjust(all, 'visible', 0), null);
    assert.deepEqual(frameAdjust(all, 'visible', 1), set({ tint: 5 }));
    assert.equal(frameAdjust(all, 'ir', 1), null);
    assert.equal(frameAdjust(all, 'visible', 2), null);
  });

  it('reads a set’s key on a set and a recording’s on a recording, never the other', () => {
    const both = {
      pictureAdjust: { version: V, views: { ir: set({ hue: 10 }) } },
      photoPictureAdjust: { version: V, photos: [{ ir: set({ hue: 20 }) }] },
    };
    assert.deepEqual(frameAdjust(experimentAdjusts(both, 0), 'ir', 0), set({ hue: 10 }));
    assert.deepEqual(frameAdjust(experimentAdjusts(both, 1), 'ir', 0), set({ hue: 20 }));
  });

  it('nothing processed: nothing to draw, and nothing said to be', () => {
    const all = experimentAdjusts({}, 0);
    assert.equal(anyAdjusted(all), false);
    assert.equal(frameAdjust(all, 'ir', 0), null);
  });

  it('the still’s Captured view has no counterpart here', () => {
    const exp = { photoPictureAdjust: { version: V, photos: [{ captured: set({ contrast: 40 }) }] } };
    const all = experimentAdjusts(exp, 1);
    for (const mode of ['ir', 'visible', 'blended'] as const) assert.equal(frameAdjust(all, mode, 0), null);
  });
});

describe('what a copy carries', () => {
  it('the settings as they are on the source, and no key where the source has none', () => {
    const pictureAdjust = { version: V, views: { ir: set({ hue: 10 }) } };
    assert.deepEqual(adjustFieldsOf({ pictureAdjust }), { pictureAdjust });
    const photoPictureAdjust = { version: V, photos: [null] };
    assert.deepEqual(adjustFieldsOf({ photoPictureAdjust }), { photoPictureAdjust });
    assert.deepEqual(adjustFieldsOf({}), {});
    // (Firestore rejects undefined: a key is written only for something that is there.)
    assert.deepEqual(adjustFieldsOf({ pictureAdjust: undefined, photoPictureAdjust: null }), {});
  });
});
