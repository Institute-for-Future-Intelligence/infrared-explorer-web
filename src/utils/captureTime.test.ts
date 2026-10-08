import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExperimentType } from '../types';
import { CaptureDoc, resolveCaptureTime } from './captureTime';

const at = (ms: number) => ({ toMillis: () => ms });
const none = () => undefined;

describe('resolveCaptureTime', () => {
  it('reads a photo set from its earliest stamped photo', () => {
    const set: CaptureDoc = {
      sourceType: ExperimentType.Photos,
      photoCapturedAt: [0, 3000, 2000],
      createdAt: at(9000),
    };
    assert.deepEqual(resolveCaptureTime(set, none), { time: { ms: 2000, exact: true } });
  });

  it('reads a time-lapse from the start of its take', () => {
    const lapse: CaptureDoc = { sourceType: ExperimentType.Recording, startedAt: 5000, createdAt: at(9000) };
    assert.deepEqual(resolveCaptureTime(lapse, none), { time: { ms: 5000, exact: true } });
  });

  it('falls back to the upload time of an original app recording, flagged as not exact', () => {
    const rec: CaptureDoc = { sourceType: ExperimentType.Recording, createdAt: at(9000) };
    assert.deepEqual(resolveCaptureTime(rec, none), { time: { ms: 9000, exact: false } });
    // A set with no photo stamped is no better off.
    const set: CaptureDoc = { sourceType: ExperimentType.Photos, photoCapturedAt: [0, 0], createdAt: at(9000) };
    assert.deepEqual(resolveCaptureTime(set, none), { time: { ms: 9000, exact: false } });
  });

  it('knows nothing about an original video or a doc without createdAt', () => {
    assert.deepEqual(resolveCaptureTime({ sourceType: ExperimentType.Video, createdAt: at(9000) }, none), {
      time: null,
    });
    assert.deepEqual(resolveCaptureTime({ sourceType: ExperimentType.Recording }, none), { time: null });
  });

  it('takes a copy back to its original, never its own createdAt', () => {
    const docs: Record<string, CaptureDoc> = {
      orig: { sourceType: ExperimentType.Recording, createdAt: at(1000) },
      copy: { sourceType: ExperimentType.Recording, clonedFrom: 'orig', createdAt: at(8000) },
    };
    const copyOfCopy: CaptureDoc = { sourceType: ExperimentType.Recording, clonedFrom: 'copy', createdAt: at(9000) };
    assert.deepEqual(
      resolveCaptureTime(copyOfCopy, (id) => docs[id]),
      { time: { ms: 1000, exact: false } },
    );
  });

  it('stops at a copy that carries the stamp itself', () => {
    const copy: CaptureDoc = { sourceType: ExperimentType.Recording, clonedFrom: 'gone', startedAt: 4000 };
    assert.deepEqual(
      resolveCaptureTime(copy, () => null),
      { time: { ms: 4000, exact: true } },
    );
  });

  it('names a source that is not loaded yet, and gives up on one that cannot be had', () => {
    const copy: CaptureDoc = { sourceType: ExperimentType.Recording, clonedFrom: 'orig', createdAt: at(9000) };
    assert.deepEqual(resolveCaptureTime(copy, none), { time: null, missing: 'orig' });
    assert.deepEqual(
      resolveCaptureTime(copy, () => null),
      { time: null },
    );
  });

  it('survives a clonedFrom cycle', () => {
    const docs: Record<string, CaptureDoc> = {
      a: { sourceType: ExperimentType.Recording, clonedFrom: 'b' },
      b: { sourceType: ExperimentType.Recording, clonedFrom: 'a' },
    };
    assert.deepEqual(
      resolveCaptureTime(docs.a, (id) => docs[id]),
      { time: null },
    );
  });
});
