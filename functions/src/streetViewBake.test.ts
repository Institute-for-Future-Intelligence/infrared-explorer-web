/**
 * The street-view bake, without a bucket or an ffmpeg: the decisions it makes and the IO
 * order it keeps, driven through fakes.
 *
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STREET_BAKE_VERSION,
  TRACKS,
  UGC_CACHE_CONTROL,
  bakeDecision,
  bakeDocPatch,
  bakeFrameCount,
  bakeStreetView,
  completeTracks,
  contentDurationSec,
  ffmpegStreamArgs,
  isFrameObject,
  missingFrames,
  storageMediaUrl,
  type BakeBucket,
  type BakeDb,
  type BakeFile,
} from './streetViewBake';

const upload = (frames: number, extra: Record<string, unknown> = {}) => ({
  sourceType: 'pano',
  ownerId: 'abc123',
  shots: Array.from({ length: frames }, (_, i) => ({ index: i + 1, azimuthDeg: i * 3, pitchDeg: 0 })),
  ...extra,
});

describe('bakeFrameCount', () => {
  it('counts shots[] first, the seed arrays next, frameCount last', () => {
    assert.equal(bakeFrameCount(upload(110)), 110);
    assert.equal(bakeFrameCount({ azimuthDeg: [1, 2, 3] }), 3);
    assert.equal(bakeFrameCount({ frameCount: 7.9 }), 7);
    assert.equal(bakeFrameCount({}), 0);
    assert.equal(bakeFrameCount(undefined), 0);
  });
});

describe('bakeDecision', () => {
  it('bakes an app upload', () => {
    assert.deepEqual(bakeDecision(upload(110)), { bake: true, frameCount: 110 });
  });

  it('leaves every seeded panorama to the offline scripts', () => {
    assert.deepEqual(bakeDecision(upload(100, { ownerId: 'system' })), { bake: false, reason: 'legacy' });
    assert.deepEqual(bakeDecision(upload(100, { legacy: true })), { bake: false, reason: 'legacy' });
    assert.deepEqual(bakeDecision(upload(100, { virUrl: 'https://x/y.vir' })), { bake: false, reason: 'legacy' });
  });

  it('skips what is already baked at this version, unless told to redo', () => {
    const baked = upload(100, { streamUrl: 'https://x/stream_mix.mp4', bakeVersion: STREET_BAKE_VERSION });
    assert.deepEqual(bakeDecision(baked), { bake: false, reason: 'baked' });
    assert.deepEqual(bakeDecision(baked, { redo: true }), { bake: true, frameCount: 100 });
    // A streamUrl from an older recipe is re-baked.
    assert.deepEqual(bakeDecision(upload(100, { streamUrl: 'https://x/old.mp4' })), { bake: true, frameCount: 100 });
  });

  it('refuses what cannot be looked around in', () => {
    assert.deepEqual(bakeDecision(undefined), { bake: false, reason: 'missing' });
    assert.deepEqual(bakeDecision(upload(1)), { bake: false, reason: 'too-few-frames' });
    assert.deepEqual(bakeDecision(upload(5, { sourceType: 'single' })), { bake: false, reason: 'not-pano' });
  });
});

describe('completeTracks / missingFrames', () => {
  const names = (kinds: string[], n: number, drop: string[] = []) => {
    const set = new Set<string>();
    for (const k of kinds) for (let i = 1; i <= n; i++) set.add(k.replace('N', String(i)));
    for (const d of drop) set.delete(d);
    return set;
  };

  it('offers only the tracks whose every frame is there, in default-view order', () => {
    const all = completeTracks(names(['data_N.dat', 'data_N.png', 'mix_N.jpg', 'vis_N.jpg'], 4), 4);
    assert.deepEqual(
      all.map((t) => t.track),
      ['mix', 'ir', 'vis'],
    );
    const noMix = completeTracks(names(['data_N.dat', 'data_N.png', 'mix_N.jpg', 'vis_N.jpg'], 4, ['mix_3.jpg']), 4);
    assert.deepEqual(
      noMix.map((t) => t.track),
      ['ir', 'vis'],
    );
    const irOnly = completeTracks(names(['data_N.dat', 'data_N.png'], 4), 4);
    assert.deepEqual(
      irOnly.map((t) => t.track),
      ['ir'],
    );
  });

  it('names the frames a track is missing', () => {
    const ir = TRACKS.find((t) => t.track === 'ir')!;
    assert.deepEqual(missingFrames(names(['data_N.png'], 5, ['data_2.png', 'data_5.png']), ir, 5), [2, 5]);
  });
});

describe('ffmpegStreamArgs', () => {
  it('is the all-intra recipe: one keyframe per frame, 5 fps, padded, scaled down only, faststart', () => {
    const args = ffmpegStreamArgs('/w/ir/f_%d.png', '/w/stream_ir.mp4', { width: 480, crf: 22 });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(at('-framerate'), '5');
    assert.equal(at('-start_number'), '1');
    assert.equal(at('-i'), '/w/ir/f_%d.png');
    assert.equal(at('-g'), '1');
    assert.equal(at('-keyint_min'), '1');
    assert.equal(at('-sc_threshold'), '0');
    assert.equal(at('-crf'), '22');
    assert.equal(at('-vf'), 'scale=w=min(480\\,iw):h=-2,tpad=stop_mode=clone:stop_duration=8');
    assert.equal(at('-movflags'), '+faststart');
    assert.ok(args.includes('-an'));
    assert.equal(args[args.length - 1], '/w/stream_ir.mp4');
  });
});

describe('bakeDocPatch', () => {
  it('makes the first baked track the default and names every track by its field', () => {
    const now = new Date('2026-09-18T20:00:00Z');
    const patch = bakeDocPatch({ bucketName: 'b.appspot.com', svId: 'sv1', baked: TRACKS, frameCount: 110, now });
    const url = (o: string) => storageMediaUrl('b.appspot.com', `streetviews/sv1/${o}`);
    assert.deepEqual(patch, {
      streamUrl: url('stream_mix.mp4'),
      streamView: 'blended',
      streamMixUrl: url('stream_mix.mp4'),
      streamIrUrl: url('stream_ir.mp4'),
      streamVisUrl: url('stream_vis.mp4'),
      videoDurationSec: 22,
      streamFrameCount: 110,
      bakeVersion: STREET_BAKE_VERSION,
      bakedAt: now,
    });
  });

  it('falls back to the IR render as the default when the blend was not uploaded', () => {
    const ir = TRACKS.filter((t) => t.track === 'ir');
    const patch = bakeDocPatch({ bucketName: 'b', svId: 'sv1', baked: ir, frameCount: 50, now: new Date(0) });
    assert.equal(patch.streamView, 'ir');
    assert.equal(patch.streamUrl, patch.streamIrUrl);
    assert.equal('streamMixUrl' in patch, false);
    assert.equal(patch.videoDurationSec, 10);
  });

  it('encodes the object path as one segment, the way the viewers address frames', () => {
    assert.equal(
      storageMediaUrl('infrared-explorer.appspot.com', 'streetviews/sv1/stream_ir.mp4'),
      'https://firebasestorage.googleapis.com/v0/b/infrared-explorer.appspot.com/o/streetviews%2Fsv1%2Fstream_ir.mp4?alt=media',
    );
  });
});

describe('contentDurationSec / isFrameObject', () => {
  it('is the frame clock, not the padded file', () => {
    assert.equal(contentDurationSec(110), 22);
  });
  it('recognises the upload contract and nothing else', () => {
    for (const n of ['data_1.dat', 'data_110.png', 'mix_7.jpg', 'vis_7.jpg']) assert.equal(isFrameObject(n), true, n);
    for (const n of ['stream_ir.mp4', 'pano.jpg', 'data_1.jpg', 'meta.json']) assert.equal(isFrameObject(n), false, n);
  });
});

// ── bakeStreetView through fakes ────────────────────────────────────────────────

interface FakeWorld {
  doc: Record<string, unknown> | undefined;
  objects: string[];
  updates: Record<string, unknown>[];
  uploads: { destination: string; contentType: string; cacheControl: string }[];
  retagged: string[];
  ffmpegRuns: string[][];
}

function fakeDeps(world: FakeWorld, workDir: string) {
  const prefix = 'streetviews/sv1/';
  const files: BakeFile[] = world.objects.map((name) => ({
    name: prefix + name,
    async download({ destination }) {
      await writeFile(destination, name);
    },
    async setMetadata() {
      world.retagged.push(name);
    },
  }));
  const bucket: BakeBucket = {
    name: 'b.appspot.com',
    async getFiles() {
      return [files];
    },
    async upload(_localPath, options) {
      world.uploads.push({
        destination: options.destination,
        contentType: options.metadata.contentType,
        cacheControl: options.metadata.cacheControl,
      });
    },
  };
  const db: BakeDb = {
    doc() {
      return {
        async get() {
          return { exists: world.doc !== undefined, data: () => world.doc };
        },
        async update(patch) {
          world.updates.push(patch);
        },
      };
    },
  };
  const runFfmpeg = async (_ffmpeg: string, args: string[]) => {
    world.ffmpegRuns.push(args);
    // The output is the last arg; write something so stat() sees bytes.
    await writeFile(args[args.length - 1], 'mp4');
  };
  return { db, bucket, ffmpegPath: '/fake/ffmpeg', runFfmpeg, workDir, now: () => new Date(0) };
}

const objectsFor = (frames: number, kinds: string[]) => {
  const out: string[] = [];
  for (let n = 1; n <= frames; n++) for (const k of kinds) out.push(k.replace('N', String(n)));
  return out;
};

describe('bakeStreetView', () => {
  it('encodes every complete track, uploads, retags the frames and stamps the doc — in that order', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'svbake-test-'));
    try {
      const world: FakeWorld = {
        doc: upload(3),
        objects: objectsFor(3, ['data_N.dat', 'data_N.png', 'mix_N.jpg', 'vis_N.jpg']),
        updates: [],
        uploads: [],
        retagged: [],
        ffmpegRuns: [],
      };
      const result = await bakeStreetView('sv1', fakeDeps(world, workDir));
      assert.ok('baked' in result);
      assert.deepEqual(
        result.baked.map((b) => [b.track, b.location]),
        [
          ['mix', 'streetviews/sv1/stream_mix.mp4'],
          ['ir', 'streetviews/sv1/stream_ir.mp4'],
          ['vis', 'streetviews/sv1/stream_vis.mp4'],
        ],
      );
      assert.deepEqual(result.skipped, []);
      assert.equal(result.framesRetagged, 12);
      // ffmpeg saw each track's own frames, numbered from 1, at the track's width.
      assert.equal(world.ffmpegRuns.length, 3);
      assert.match(world.ffmpegRuns[0][world.ffmpegRuns[0].indexOf('-i') + 1], /[\\/]mix[\\/]f_%d\.jpg$/);
      assert.match(world.ffmpegRuns[1][world.ffmpegRuns[1].indexOf('-i') + 1], /[\\/]ir[\\/]f_%d\.png$/);
      assert.ok(world.ffmpegRuns[1].includes('scale=w=min(480\\,iw):h=-2,tpad=stop_mode=clone:stop_duration=8'));
      // Uploaded cacheable, as video.
      assert.deepEqual(world.uploads, [
        { destination: 'streetviews/sv1/stream_mix.mp4', contentType: 'video/mp4', cacheControl: UGC_CACHE_CONTROL },
        { destination: 'streetviews/sv1/stream_ir.mp4', contentType: 'video/mp4', cacheControl: UGC_CACHE_CONTROL },
        { destination: 'streetviews/sv1/stream_vis.mp4', contentType: 'video/mp4', cacheControl: UGC_CACHE_CONTROL },
      ]);
      // The doc is stamped once, after everything landed.
      assert.equal(world.updates.length, 1);
      assert.equal(world.updates[0].streamView, 'blended');
      assert.equal(world.updates[0].videoDurationSec, 0.6);
      assert.equal(world.updates[0].streamFrameCount, 3);
      assert.equal(world.updates[0].bakeVersion, STREET_BAKE_VERSION);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('bakes the IR render alone when the blend and visible frames were not uploaded', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'svbake-test-'));
    try {
      const world: FakeWorld = {
        doc: upload(2),
        objects: objectsFor(2, ['data_N.dat', 'data_N.png']),
        updates: [],
        uploads: [],
        retagged: [],
        ffmpegRuns: [],
      };
      const result = await bakeStreetView('sv1', fakeDeps(world, workDir));
      assert.ok('baked' in result);
      assert.deepEqual(
        result.baked.map((b) => b.track),
        ['ir'],
      );
      assert.deepEqual(result.skipped, ['mix', 'vis']);
      assert.equal(world.updates[0].streamView, 'ir');
      assert.equal(world.updates[0].streamUrl, world.updates[0].streamIrUrl);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('refuses an upload missing a contract frame instead of baking a shorter sweep', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'svbake-test-'));
    try {
      const world: FakeWorld = {
        doc: upload(3),
        objects: objectsFor(3, ['data_N.dat', 'data_N.png']).filter((n) => n !== 'data_2.png'),
        updates: [],
        uploads: [],
        retagged: [],
        ffmpegRuns: [],
      };
      await assert.rejects(
        bakeStreetView('sv1', fakeDeps(world, workDir)),
        /data_N\.png incomplete — 1 of 3 missing \(first: 2\)/,
      );
      assert.equal(world.updates.length, 0);
      assert.equal(world.uploads.length, 0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('localOnly keeps the streams on disk and touches nothing in the cloud', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'svbake-test-'));
    try {
      const world: FakeWorld = {
        doc: upload(2),
        objects: objectsFor(2, ['data_N.dat', 'data_N.png', 'mix_N.jpg']),
        updates: [],
        uploads: [],
        retagged: [],
        ffmpegRuns: [],
      };
      const result = await bakeStreetView('sv1', fakeDeps(world, workDir), { localOnly: true });
      assert.ok('baked' in result);
      assert.equal(result.baked[0].location, join(workDir, 'stream_mix.mp4'));
      assert.equal(await readFile(result.baked[0].location, 'utf8'), 'mp4');
      assert.equal(world.uploads.length, 0);
      assert.equal(world.updates.length, 0);
      assert.equal(world.retagged.length, 0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('reports why it did nothing for a doc that needs no bake', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'svbake-test-'));
    try {
      const world: FakeWorld = {
        doc: upload(100, { ownerId: 'system' }),
        objects: [],
        updates: [],
        uploads: [],
        retagged: [],
        ffmpegRuns: [],
      };
      assert.deepEqual(await bakeStreetView('sv1', fakeDeps(world, workDir)), { svId: 'sv1', skippedReason: 'legacy' });
      assert.equal(world.ffmpegRuns.length, 0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
