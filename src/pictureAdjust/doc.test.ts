import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NO_ADJUST, PictureAdjust } from './core/pictureAdjustParams';
import {
  PICTURE_ADJUST_DOC_VERSION,
  adjustDocFields,
  adjustFieldsOf,
  anyAdjusted,
  experimentAdjusts,
  frameAdjust,
  photoAdjusts,
  recordingAdjusts,
  sameAdjusts,
  withFrameAdjust,
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

describe('the Process panel’s edit of the settings', () => {
  const none = { recording: null, photos: null };

  it('sets and takes off one view of a recording, leaving the others', () => {
    const ir = set({ contrast: 20 });
    const one = withFrameAdjust(none, 'ir', ir, 0);
    assert.deepEqual(one, { recording: { ir }, photos: null });
    const two = withFrameAdjust(one, 'visible', set({ brightness: 5 }), 0);
    assert.deepEqual(two.recording, { ir, visible: set({ brightness: 5 }) });
    // Settings that change nothing take the view out; the last one out leaves the recording as made.
    assert.deepEqual(withFrameAdjust(two, 'visible', set({}), 0).recording, { ir });
    assert.deepEqual(withFrameAdjust(one, 'ir', null, 0), none);
  });

  it('keeps a view this site does not show (a still’s captured view) through an edit', () => {
    const captured = set({ warmth: 10 });
    const from = { recording: null, photos: [{ captured }, null] };
    const next = withFrameAdjust(from, 'ir', set({ contrast: 9 }), 2, 0);
    assert.deepEqual(next.photos, [{ captured, ir: set({ contrast: 9 }) }, null]);
  });

  it('edits one photo of a set, starting the list where there was none', () => {
    const blended = set({ saturation: -40 });
    const next = withFrameAdjust(none, 'blended', blended, 3, 1);
    assert.deepEqual(next, { recording: null, photos: [null, { blended }, null] });
    assert.deepEqual(withFrameAdjust(next, 'blended', null, 3, 1), none);
    // A slot the set does not have changes nothing.
    assert.deepEqual(withFrameAdjust(next, 'ir', blended, 3, 3), next);
  });

  it('tells settings that draw the same from ones that do not', () => {
    const ir = set({ contrast: 20 });
    assert.equal(sameAdjusts(none, { recording: {}, photos: null }), true);
    assert.equal(
      sameAdjusts({ recording: { ir }, photos: null }, { recording: { ir: { ...ir } }, photos: null }),
      true,
    );
    assert.equal(sameAdjusts({ recording: { ir }, photos: null }, none), false);
    assert.equal(sameAdjusts({ recording: { ir: set({}) }, photos: null }, none), true);
    assert.equal(
      sameAdjusts({ recording: null, photos: [null, { ir }] }, { recording: null, photos: [null, { ir }] }),
      true,
    );
    assert.equal(
      sameAdjusts({ recording: null, photos: [null, { ir }] }, { recording: null, photos: [{ ir }, null] }),
      false,
    );
  });

  it('writes them as the app does, and reads back what it wrote', () => {
    const ir = set({ contrast: 20, effects: [{ effect: 'edge', amount: 50 }] });
    const rec = adjustDocFields({ recording: { ir }, photos: null }, 0);
    assert.deepEqual(rec, { pictureAdjust: { version: V, views: { ir } }, photoPictureAdjust: null });
    assert.deepEqual(recordingAdjusts(rec.pictureAdjust), { ir });
    assert.deepEqual(adjustDocFields(none, 0), { pictureAdjust: null, photoPictureAdjust: null });

    const photos = [null, { ir }];
    const setDoc = adjustDocFields({ recording: null, photos }, 2);
    assert.deepEqual(setDoc, { pictureAdjust: null, photoPictureAdjust: { version: V, photos } });
    assert.deepEqual(photoAdjusts(setDoc.photoPictureAdjust, 2), photos);
    assert.deepEqual(adjustDocFields(none, 2), { pictureAdjust: null, photoPictureAdjust: null });
  });

  it('writes nothing undefined (Firestore refuses it)', () => {
    const ir = { ...set({ contrast: 20 }), effects: undefined };
    const out = adjustDocFields({ recording: { ir }, photos: null }, 0);
    assert.equal('effects' in (out.pictureAdjust?.views.ir ?? {}), false);
  });
});
