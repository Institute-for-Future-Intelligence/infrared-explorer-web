/**
 * Tests for the photo-set analysis path: the sampling plan and catalogue (photoSet.ts) and what the shared
 * analysis module does differently on the photo axis (analysis.ts — the digest, the figure sanitizer,
 * the cache key and freshness descriptor, the verifier).
 *
 * Run: npm test   (node:test via tsx — see the root package.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRawFrame, INTSIZE, type DecodedFrame } from './thermal';
import {
  normalizePhotoOrder,
  photoAtPlace,
  photoCatalogue,
  photoHasThermal,
  pickPhotoSetFigureTimes,
  planPhotoSamples,
} from './photoSet';
import {
  analysisInputsHash,
  buildAnalysisDigest,
  reportInputsDescriptor,
  sanitizeReportFigures,
  verifyReportNumbers,
  type KeptFrame,
} from './analysis';

const makeFrame = (w: number, h: number, tempAt: (x: number, y: number) => number): DecodedFrame => {
  const raw = new Uint8Array(w * h * INTSIZE);
  const dv = new DataView(raw.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      dv.setUint16((y * w + x) * INTSIZE + 2, Math.round((tempAt(x, y) + 273.15) * 100), false);
    }
  }
  return decodeRawFrame(raw, w, h);
};

describe('normalizePhotoOrder (server mirror of utils/photoOrder)', () => {
  it('absent → capture order', () => {
    assert.deepEqual(normalizePhotoOrder(undefined, 3), [0, 1, 2]);
  });
  it('keeps a permutation, drops strays and repeats, appends missed slots', () => {
    assert.deepEqual(normalizePhotoOrder([2, 0, 1], 3), [2, 0, 1]);
    assert.deepEqual(normalizePhotoOrder([2, 9, 2, -1, 0.5], 4), [2, 0, 1, 3]);
  });
});

describe('planPhotoSamples', () => {
  it('reads every photo with temperature data, in viewing order, numbered by place', () => {
    const { samples, thermalCount } = planPhotoSamples({ photoCount: 3, photoOrder: [2, 0, 1] }, 25);
    assert.equal(thermalCount, 3);
    assert.deepEqual(samples, [
      { place: 1, slot: 2, recordingIndex: 3 },
      { place: 2, slot: 0, recordingIndex: 1 },
      { place: 3, slot: 1, recordingIndex: 2 },
    ]);
  });

  it('skips picture-only photos but keeps the numbering of the whole set', () => {
    const { samples, thermalCount } = planPhotoSamples({ photoCount: 3, photoThermal: [true, false, true] }, 25);
    assert.equal(thermalCount, 2);
    assert.deepEqual(
      samples.map((s) => s.place),
      [1, 3],
    );
  });

  it('spreads evenly past the limit and always keeps the first and the last', () => {
    const { samples, thermalCount } = planPhotoSamples({ photoCount: 60 }, 25);
    assert.equal(thermalCount, 60);
    assert.equal(samples.length, 25);
    assert.equal(samples[0].place, 1);
    assert.equal(samples[samples.length - 1].place, 60);
    const places = samples.map((s) => s.place);
    assert.deepEqual(
      places,
      [...places].sort((a, b) => a - b),
    );
    assert.equal(new Set(places).size, places.length);
  });

  it('an empty set, or one with no thermal photo, plans nothing', () => {
    assert.deepEqual(planPhotoSamples({}, 25), { samples: [], thermalCount: 0 });
    assert.deepEqual(planPhotoSamples({ photoCount: 2, photoThermal: [false, false] }, 25), {
      samples: [],
      thermalCount: 0,
    });
  });
});

describe('photoAtPlace / photoHasThermal', () => {
  const exp = { photoCount: 3, photoOrder: [2, 0, 1], photoThermal: [true, true, false] };
  it('resolves a place through the order, rounding the number the model gave', () => {
    assert.deepEqual(photoAtPlace(exp, 1), { place: 1, slot: 2, recordingIndex: 3 });
    assert.deepEqual(photoAtPlace(exp, 2.4), { place: 2, slot: 0, recordingIndex: 1 });
  });
  it('a number off either end is null, never clamped onto another photo', () => {
    assert.equal(photoAtPlace(exp, 0), null);
    assert.equal(photoAtPlace(exp, 4), null);
    assert.equal(photoAtPlace(exp, Number.NaN), null);
    assert.equal(photoAtPlace({}, 1), null);
  });
  it('reads the thermal flag by capture slot', () => {
    assert.equal(photoHasThermal(exp, 2), false);
    assert.equal(photoHasThermal(exp, 0), true);
    assert.equal(photoHasThermal({ photoCount: 1 }, 0), true);
  });
});

describe('photoCatalogue', () => {
  it('lists every photo in viewing order with its caption, clock and thermal flag', () => {
    const cat = photoCatalogue({
      photoCount: 3,
      photoOrder: [1, 0, 2],
      photoThermal: [true, true, false],
      photoCapturedAt: [1_700_000_060_000, 1_700_000_000_000, 0],
      photoTitles: ['wall', '', '  roof  '],
    });
    assert.deepEqual(cat, [
      {
        n: 1,
        thermal: true,
        caption: null,
        capturedAt: new Date(1_700_000_000_000).toISOString(),
        sinceFirstSec: 0,
      },
      {
        n: 2,
        thermal: true,
        caption: 'wall',
        capturedAt: new Date(1_700_000_060_000).toISOString(),
        sinceFirstSec: 60,
      },
      { n: 3, thermal: false, caption: 'roof', capturedAt: null, sinceFirstSec: null },
    ]);
  });
  it('with no clock at all, every capture time is null', () => {
    const cat = photoCatalogue({ photoCount: 2 });
    assert.deepEqual(
      cat.map((c) => [c.capturedAt, c.sinceFirstSec]),
      [
        [null, null],
        [null, null],
      ],
    );
  });
});

describe('pickPhotoSetFigureTimes', () => {
  const fg = (n: number, hottest: number) =>
    Array.from({ length: n }, (_, i) => ({ t: i + 1, max: i + 1 === hottest ? 90 : 30 }));
  it('shows the whole set when it fits', () => {
    assert.deepEqual(pickPhotoSetFigureTimes(fg(3, 2), 4), [1, 2, 3]);
  });
  it('past the budget keeps the first, the hottest and the last, sorted and unique', () => {
    const picked = pickPhotoSetFigureTimes(fg(12, 7), 4);
    assert.equal(picked.length, 4);
    assert.ok(picked.includes(1) && picked.includes(7) && picked.includes(12));
    assert.deepEqual(
      picked,
      [...picked].sort((a, b) => a - b),
    );
    assert.equal(new Set(picked).size, 4);
  });
  it('nothing for nothing', () => {
    assert.deepEqual(pickPhotoSetFigureTimes([], 4), []);
    assert.deepEqual(pickPhotoSetFigureTimes(fg(3, 1), 0), []);
  });
});

describe('buildAnalysisDigest on the photo axis', () => {
  // Three "photos" of different scenes: a warm blob that changes place, so a clip digest would fit and
  // narrate it. On the photo axis none of that may appear.
  const PLACES = [1, 2, 3];
  const frames: KeptFrame[] = PLACES.map((p, i) => ({
    frame: makeFrame(40, 40, (x) => (Math.floor(x / 14) === i ? 60 + 10 * i : 20)),
    recordingIndex: p,
    tSec: p,
  }));
  const series = [61, 22, 20];
  const frameGlobal = PLACES.map((p, i) => ({
    t: p,
    min: 20,
    max: 60 + 10 * i,
    mean: 30,
    hotspot: { x: (14 * i + 7) / 40, y: 0.5 },
  }));
  const digest = buildAnalysisDigest({
    times: PLACES,
    thermometers: [{ label: 'T1', series }],
    frameGlobal,
    frames,
    profileLines: [{ x1: 0, y1: 0.5, x2: 1, y2: 0.5 }],
    axis: 'photo',
  });

  it('withholds everything that needs a clock', () => {
    const t1 = digest.thermometers[0];
    assert.equal(t1.signal, null);
    assert.equal(t1.newtonFit, null);
    assert.equal(t1.peakRate, null);
    assert.deepEqual(t1.phases, []);
    assert.deepEqual(digest.events, []);
    assert.equal(digest.clip.hotspotDrift, null);
    assert.match(digest.note, /PHOTO NUMBER/);
  });

  it('keeps the per-photo quantities, stamped with photo numbers', () => {
    const t1 = digest.thermometers[0];
    assert.deepEqual(t1.maxAt, { t: 1, tempC: 61 });
    assert.deepEqual(t1.minAt, { t: 3, tempC: 20 });
    assert.ok(digest.clip.warmArea && digest.clip.warmArea.length > 0);
    for (const w of digest.clip.warmArea!) assert.ok(PLACES.includes(w.atT));
    assert.equal(digest.profileLines.length, 1);
    assert.ok(digest.profileLines[0].gradients.length > 0);
    for (const g of digest.profileLines[0].gradients) assert.ok(PLACES.includes(g.t));
  });

  it('the time axis is unchanged by the new option (signal still assessed, drift still measured)', () => {
    const clip = buildAnalysisDigest({
      times: PLACES,
      thermometers: [{ label: 'T1', series }],
      frameGlobal,
      frames,
      profileLines: [],
    });
    assert.ok(clip.thermometers[0].signal);
    assert.ok(clip.clip.hotspotDrift);
  });
});

describe('sanitizeReportFigures on the photo axis', () => {
  const photos = [1, 2, 3];
  it('keeps a marker that names a decoded photo and writes it in the photo form', () => {
    assert.equal(
      sanitizeReportFigures('a\n[figure: photo 2 | the window]\nb', photos, 4, 'photo'),
      'a\n[figure: photo 2 | the window]\nb',
    );
  });
  it('rewrites a marker written in the clip form into the photo form', () => {
    assert.equal(sanitizeReportFigures('[figure: t = 3 s | roof]', photos, 4, 'photo'), '[figure: photo 3 | roof]');
  });
  it('snaps a rounded number and drops a photo the set does not have', () => {
    assert.equal(sanitizeReportFigures('[figure: photo 2.4]', photos, 4, 'photo'), '[figure: photo 2]');
    assert.equal(sanitizeReportFigures('x\n[figure: photo 7 | none]\ny', photos, 4, 'photo'), 'x\ny');
  });
  it('the default axis still writes the clip form', () => {
    assert.equal(sanitizeReportFigures('[figure: t = 10 s | onset]', [0, 10, 20], 4), '[figure: t = 10 s | onset]');
  });
});

describe('cache key and freshness descriptor for a photo set', () => {
  const base = { sourceType: 'photos', recordingId: 'rec_p', duration: 0, photoCount: 3 };
  const probes = [{ x: 0.5, y: 0.5 }];

  it('a recording carries no photo fields (its hash and descriptor are unchanged)', () => {
    const rec = { sourceType: 'recording', recordingId: 'rec_r', duration: 10 };
    const d = reportInputsDescriptor(rec, 25) as Record<string, unknown>;
    assert.ok(!('photoCount' in d) && !('photoOrder' in d));
  });

  it('the viewing order is an input: reordering changes both, an untouched order equals the identity', () => {
    const h0 = analysisInputsHash(base, probes, 25);
    const hIdentity = analysisInputsHash({ ...base, photoOrder: [0, 1, 2] }, probes, 25);
    const hSwapped = analysisInputsHash({ ...base, photoOrder: [2, 1, 0] }, probes, 25);
    assert.equal(h0, hIdentity);
    assert.notEqual(h0, hSwapped);
    assert.deepEqual(reportInputsDescriptor({ ...base, photoOrder: [2, 1, 0] }, 25).photoOrder, [2, 1, 0]);
    assert.deepEqual(reportInputsDescriptor(base, 25).photoOrder, [0, 1, 2]);
    assert.equal(reportInputsDescriptor(base, 25).photoCount, 3);
  });

  it('which photos carry temperatures is part of the key', () => {
    assert.notEqual(
      analysisInputsHash(base, probes, 25),
      analysisInputsHash({ ...base, photoThermal: [true, false, true] }, probes, 25),
    );
  });
});

describe('verifyReportNumbers with a photo catalogue', () => {
  it('accepts the seconds between shots as legal times', () => {
    const summary = {
      times: [1, 2],
      thermometers: [
        { series: [30, 40], min: 30, max: 40, startTemp: null, endTemp: null, changeC: null, secantCPerSec: null },
      ],
      frameGlobal: [
        { t: 1, min: 20, max: 30, mean: 25 },
        { t: 2, min: 20, max: 40, mean: 30 },
      ],
      photos: [{ sinceFirstSec: 0 }, { sinceFirstSec: 90 }],
    };
    const res = verifyReportNumbers('Photo 2 was taken 90 s after photo 1 and reads 40 °C.', summary, null);
    assert.equal(res.unmatched.length, 0, JSON.stringify(res.unmatched));
    const bad = verifyReportNumbers('Photo 2 was taken 45 s after photo 1.', summary, null);
    assert.equal(bad.unmatched.length, 1);
  });
});
