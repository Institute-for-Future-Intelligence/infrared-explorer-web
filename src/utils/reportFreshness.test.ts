/**
 * Parity + behaviour tests for the report freshness check.
 *
 * The parity case is the important one: the descriptor is written by the Cloud Function and compared by
 * the browser, so the two implementations must serialize identically for the same experiment document.
 * They live in separate builds with no shared package, so nothing but this test stops them drifting —
 * and a drift would not fail loudly, it would quietly mark every current report "outdated".
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reportInputsDescriptor as serverDescriptor } from '../../functions/src/analysis';
import { isReportStale, reportInputsDescriptor as clientDescriptor, REPORT_FRAME_SAMPLES } from './reportFreshness';

/** One experiment document, exercising every field the descriptor reads. */
const FIXTURE = {
  sourceType: 'recording',
  recordingId: 'rec_abc123',
  name: null,
  duration: 28.2,
  segments: [
    { start: 10, end: 60 },
    { start: 90, end: 120 },
  ],
  profileLines: [
    { id: 'l1', name: 'across the rim', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, lengthCm: 12 },
    { id: 'l2', x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
  ],
};

describe('reportInputsDescriptor parity', () => {
  it('serializes identically on both sides for the same document', () => {
    assert.equal(
      JSON.stringify(clientDescriptor(FIXTURE, REPORT_FRAME_SAMPLES)),
      JSON.stringify(serverDescriptor(FIXTURE, REPORT_FRAME_SAMPLES)),
    );
  });

  it('agrees on a bare document with every optional field missing', () => {
    const bare = {};
    assert.equal(
      JSON.stringify(clientDescriptor(bare, REPORT_FRAME_SAMPLES)),
      JSON.stringify(serverDescriptor(bare, REPORT_FRAME_SAMPLES)),
    );
  });

  it('agrees on a video experiment with no trim and no transects', () => {
    const video = { sourceType: 'video', name: 'ice-melt', duration: 41 };
    assert.equal(
      JSON.stringify(clientDescriptor(video, REPORT_FRAME_SAMPLES)),
      JSON.stringify(serverDescriptor(video, REPORT_FRAME_SAMPLES)),
    );
  });

  it('leaves an uncalibrated transect as null rather than dropping the field', () => {
    const d = clientDescriptor(FIXTURE);
    assert.equal(d.profileLines[1].lengthCm, null);
    assert.equal(d.profileLines[0].lengthCm, 12);
  });

  it('contains no array-of-array, which Firestore refuses to store', () => {
    // The descriptor is persisted on the experiment document. A tuple form would make that write throw
    // — after the model call, so the report would be paid for and then lost.
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) {
        for (const [i, item] of v.entries()) {
          assert.ok(!Array.isArray(item), `${path}[${i}] is a nested array`);
          walk(item, `${path}[${i}]`);
        }
      } else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) walk(val, `${path}.${k}`);
      }
    };
    walk(clientDescriptor(FIXTURE), 'descriptor');
    walk(serverDescriptor(FIXTURE, REPORT_FRAME_SAMPLES), 'serverDescriptor');
  });
});

describe('isReportStale', () => {
  const saved = clientDescriptor(FIXTURE);

  it('says no when nothing that feeds the numbers has changed', () => {
    // A renamed transect and a new description are cosmetic: neither reaches the descriptor.
    const edited = {
      ...FIXTURE,
      description: 'now with a longer write-up',
      profileLines: [{ ...FIXTURE.profileLines[0], name: 'renamed' }, FIXTURE.profileLines[1]],
      aiReportInputs: saved,
    };
    assert.equal(isReportStale(edited), false);
  });

  it('says yes when the clip is re-trimmed', () => {
    assert.equal(isReportStale({ ...FIXTURE, segments: [{ start: 0, end: 40 }], aiReportInputs: saved }), true);
  });

  it('says yes when a transect is moved, added or calibrated', () => {
    assert.equal(
      isReportStale({ ...FIXTURE, profileLines: [FIXTURE.profileLines[0]], aiReportInputs: saved }),
      true,
      'a transect was deleted',
    );
    assert.equal(
      isReportStale({
        ...FIXTURE,
        profileLines: [{ ...FIXTURE.profileLines[0], lengthCm: 15 }, FIXTURE.profileLines[1]],
        aiReportInputs: saved,
      }),
      true,
      'a length was recalibrated',
    );
  });

  it('is not fooled by the key order Firestore returns a map in', () => {
    // Firestore stores a map as a keyed structure and hands its fields back sorted by name, not in the
    // order they were written. Comparing raw JSON therefore declared every report outdated on every
    // page load — while looking correct in the session that generated it, because the store held the
    // response object with the server's own key order.
    const shuffle = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(shuffle);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          out[k] = shuffle((v as Record<string, unknown>)[k]);
        }
        return out;
      }
      return v;
    };
    const fromFirestore = shuffle(saved);
    assert.notEqual(JSON.stringify(fromFirestore), JSON.stringify(saved), 'fixture must actually reorder keys');
    assert.equal(isReportStale({ ...FIXTURE, aiReportInputs: fromFirestore }), false);
  });

  it('stays silent when the report predates the stamp — unknown is not a warning', () => {
    assert.equal(isReportStale({ ...FIXTURE, segments: [{ start: 0, end: 1 }] }), false);
    assert.equal(isReportStale({ ...FIXTURE, aiReportInputs: null }), false);
    assert.equal(isReportStale({ ...FIXTURE, aiReportInputs: 'nonsense' }), false);
  });
});
