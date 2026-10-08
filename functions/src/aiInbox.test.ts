/**
 * Tests for the AI report container parser.
 *
 * The container is the one thing a phone sends that the server analyses, so what matters is that a
 * well-formed one round-trips exactly (every frame, photo and header field where the packer put it)
 * and that a malformed or oversized one is refused BEFORE anything is decoded — with a message that
 * says what was wrong, since the packer is ours and a refusal means a bug on one side or the other.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeInboxContainer, INBOX_LIMITS, InboxError, isInboxReportId, parseInboxContainer } from './aiInbox';

const REPORT_ID = '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c';

function blobOf(fill: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

/** A small, well-formed container: three frames (two with photos), one pose photo, a sheet, a sidecar. */
function goodContainer(overrides: Record<string, unknown> = {}) {
  const blobs = [
    blobOf(1, 1000), // 0: dat 10
    blobOf(2, 500), // 1: vis 10
    blobOf(3, 1100), // 2: dat 25
    blobOf(4, 1200), // 3: dat 40
    blobOf(5, 600), // 4: vis 40
    blobOf(6, 3000), // 5: pose 10
    blobOf(7, 4000), // 6: contact sheet
    blobOf(8, 16 + 50 * 384), // 7: sidecar
  ];
  const header = {
    v: 1,
    reportId: REPORT_ID,
    recording: { durationSec: 10, fps: 5, frameCount: 50 },
    frames: [
      { n: 40, dat: 3, vis: 4 },
      { n: 10, dat: 0, vis: 1 },
      { n: 25, dat: 2, vis: null },
    ],
    selection: { algo: 'pe1', picked: [10, 25, 40] },
    thermometers: [
      { name: 'mug', x: 0.5, y: 0.5 },
      {
        x: 0.2,
        y: 0.8,
        measuringAreaType: 'rectangle',
        measuringAreaWidth: 0.1,
        measuringAreaHeight: 0.2,
        aiPlaced: true,
      },
    ],
    profileLines: [{ name: 'across', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, lengthCm: 12 }],
    annotations: [{ x: 0.3, y: 0.3, note: 'lid off', from: 4, to: 6 }],
    keyMoments: [{ tSeconds: 4, text: 'lid removed' }],
    title: 'Cooling mug',
    description: 'A mug of tea',
    subject: 'physics',
    posePhotos: [{ n: 10, jpeg: 5 }],
    contactSheet: 6,
    sidecar: 7,
    ...overrides,
  };
  return { bytes: encodeInboxContainer(header as never, blobs), blobs };
}

describe('parseInboxContainer', () => {
  it('round-trips a well-formed container, frames sorted and blobs where the packer put them', () => {
    const { bytes, blobs } = goodContainer();
    const c = parseInboxContainer(bytes);
    assert.equal(c.header.reportId, REPORT_ID);
    assert.deepEqual(c.frameNumbers, [10, 25, 40]);
    assert.deepEqual(Array.from(c.dat(10)!), Array.from(blobs[0]));
    assert.deepEqual(Array.from(c.photo(40)!), Array.from(blobs[4]));
    assert.equal(c.photo(25), null);
    assert.equal(c.dat(11), null);
    assert.equal(c.header.thermometers[0].label, 'T1');
    assert.equal(c.header.thermometers[0].name, 'mug');
    assert.equal(c.header.thermometers[1].measuringAreaType, 'rectangle');
    assert.equal(c.header.thermometers[1].aiPlaced, true);
    assert.equal(c.header.profileLines[0].lengthCm, 12);
    assert.deepEqual(c.header.annotations[0], { x: 0.3, y: 0.3, note: 'lid off', from: 4, to: 6 });
    assert.deepEqual(c.header.keyMoments[0], { tSeconds: 4, text: 'lid removed' });
    assert.equal(c.header.posePhotos[0].n, 10);
    assert.equal(c.blob(c.header.contactSheet!).length, 4000);
    assert.equal(c.blob(c.header.sidecar!).length, 16 + 50 * 384);
    assert.equal(c.totalBytes, bytes.length);
  });

  const refuses = (bytes: Uint8Array, pattern: RegExp) => {
    assert.throws(
      () => parseInboxContainer(bytes),
      (e: unknown) => e instanceof InboxError && pattern.test(e.message),
    );
  };

  it('refuses a container that is not one', () => {
    refuses(new Uint8Array(2), /empty/);
    const junk = new Uint8Array(64);
    new DataView(junk.buffer).setUint32(0, 20, true);
    refuses(junk, /not JSON/);
    const huge = new Uint8Array(8);
    new DataView(huge.buffer).setUint32(0, 1 << 30, true);
    refuses(huge, /header length/);
  });

  it('refuses the wrong version, a bad report id and a time-lapse', () => {
    refuses(goodContainer({ v: 2 }).bytes, /version/);
    refuses(goodContainer({ reportId: 'nope' }).bytes, /uuid/);
    refuses(
      goodContainer({ recording: { durationSec: 10, fps: 5, frameCount: 50, timelapse: true } }).bytes,
      /time-lapse/,
    );
  });

  it('refuses frames that are missing, duplicated, out of range or too many', () => {
    refuses(goodContainer({ frames: [] }).bytes, /frames has 0/);
    refuses(
      goodContainer({
        frames: [
          { n: 10, dat: 0 },
          { n: 10, dat: 2 },
        ],
      }).bytes,
      /twice/,
    );
    refuses(goodContainer({ frames: [{ n: 51, dat: 0 }] }).bytes, /frames\[0\]\.n/);
    refuses(goodContainer({ frames: [{ n: 10, dat: 99 }] }).bytes, /dat/);
    const many = Array.from({ length: INBOX_LIMITS.frames + 1 }, (_, i) => ({ n: i + 1, dat: 0 }));
    refuses(goodContainer({ recording: { durationSec: 100, fps: 5, frameCount: 500 }, frames: many }).bytes, /entries/);
  });

  it('refuses a blob that runs past the container or over its size limit', () => {
    const { bytes } = goodContainer();
    // Grow one frame's declared length past the end.
    const text = new TextDecoder().decode(bytes.subarray(4, 4 + new DataView(bytes.buffer).getUint32(0, true)));
    const tampered = JSON.parse(text) as { blobs: { offset: number; length: number }[] };
    tampered.blobs[3].length = 10_000_000;
    const headerBytes = new TextEncoder().encode(JSON.stringify(tampered));
    const out = new Uint8Array(4 + headerBytes.length + 100);
    new DataView(out.buffer).setUint32(0, headerBytes.length, true);
    out.set(headerBytes, 4);
    refuses(out, /runs past/);
    // A .dat far larger than a frame can be.
    const big = goodContainer();
    const blobs = [blobOf(1, INBOX_LIMITS.datBytes + 1)];
    const hdr = {
      ...JSON.parse(
        new TextDecoder().decode(big.bytes.subarray(4, 4 + new DataView(big.bytes.buffer).getUint32(0, true))),
      ),
    };
    delete (hdr as { blobs?: unknown }).blobs;
    (hdr as { frames: unknown }).frames = [{ n: 1, dat: 0, vis: null }];
    (hdr as { posePhotos: unknown }).posePhotos = [];
    (hdr as { contactSheet: unknown }).contactSheet = null;
    (hdr as { sidecar: unknown }).sidecar = null;
    refuses(encodeInboxContainer(hdr as never, blobs), /over the limit/);
  });

  it('clips text, drops malformed context items and caps the counts', () => {
    const c = parseInboxContainer(
      goodContainer({
        title: 'x'.repeat(500),
        annotations: [
          { x: 0.1, y: 0.1, note: '' },
          { x: 'a', y: 0.2, note: 'bad x' },
          { x: 0.5, y: 0.5, note: 'ok' },
        ],
        keyMoments: [
          { tSeconds: 'no', text: 'bad' },
          { tSeconds: 2, text: 'ok' },
        ],
      }).bytes,
    );
    assert.equal(c.header.title.length, 200);
    assert.deepEqual(
      c.header.annotations.map((a) => a.note),
      ['ok'],
    );
    assert.deepEqual(
      c.header.keyMoments.map((m) => m.text),
      ['ok'],
    );
    const tooMany = Array.from({ length: INBOX_LIMITS.thermometers + 1 }, () => ({ x: 0.5, y: 0.5 }));
    refuses(goodContainer({ thermometers: tooMany }).bytes, /too many thermometers/);
  });
});

describe('isInboxReportId', () => {
  it('accepts a uuid in either case and nothing else', () => {
    assert.equal(isInboxReportId(REPORT_ID), true);
    assert.equal(isInboxReportId(REPORT_ID.toUpperCase()), true);
    assert.equal(isInboxReportId('6f1d2c3b4a5e4f608b7c9d0e1f2a3b4c'), false);
    assert.equal(isInboxReportId(42), false);
    assert.equal(isInboxReportId('../x'), false);
  });
});

describe('parseInboxContainer capture setup', () => {
  it('carries the capture pose and the emissivity, and drops a malformed one rather than refusing', () => {
    const pose = { pitchDeg: -88.2, rollDeg: 64.3, azimuthDeg: 0 };
    const good = parseInboxContainer(goodContainer({ capturePose: pose, emissivity: 0.95 }).bytes).header;
    assert.deepEqual(good.capturePose, pose);
    assert.equal(good.emissivity, 0.95);
    const none = parseInboxContainer(goodContainer().bytes).header;
    assert.equal(none.capturePose, null);
    assert.equal(none.emissivity, null);
    const bad = parseInboxContainer(goodContainer({ capturePose: { pitchDeg: 'down' }, emissivity: 1.5 }).bytes).header;
    assert.equal(bad.capturePose, null);
    assert.equal(bad.emissivity, null);
  });
});
