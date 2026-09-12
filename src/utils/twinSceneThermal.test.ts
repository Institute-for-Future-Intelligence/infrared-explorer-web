import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TwinBuildingThermal, TwinBuildingView, TwinFace, TwinSubjectKind, TwinThermalSurface } from '../types';
import {
  buildSurfaceTable,
  faceOfNormal,
  normalizePartName,
  paletteKeyFor,
  paletteLut256,
  type SurfaceTable,
  type TwinBuiltPart,
} from './twinSceneThermal';
import { PALETTE_COLORS } from './paletteData';

// ---- fixtures -----------------------------------------------------------------------------------------
// A 10 × 10 × 10 m block standing on the ground at the origin unless told otherwise; cameras look at it.

const SIX: TwinFace[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

function part(name: string, kind: string, o: Partial<TwinBuiltPart> = {}): TwinBuiltPart {
  return {
    name,
    kinds: [kind],
    faces: SIX,
    center: [0, 5, 0],
    min: [-5, 0, -5],
    max: [5, 10, 5],
    meshCount: 1,
    round: false,
    ...o,
  };
}

function surf(
  partName: string,
  kind: string,
  face: TwinFace,
  photo: number,
  median: number,
  o: Partial<TwinThermalSurface> = {},
): TwinThermalSurface {
  return {
    part: partName,
    kind,
    face,
    photo,
    quad: [0, 0, 1, 0, 1, 1, 0, 1],
    n: 400,
    median,
    p10: median - 2,
    p90: median + 2,
    min: median - 4,
    max: median + 4,
    registered: true,
    ...o,
  };
}

const view = (photo: number, x: number, y: number, z: number): TwinBuildingView => ({
  photo,
  x,
  y,
  z,
  targetX: 0,
  targetY: 5,
  targetZ: 0,
});

const thermal = (surfaces: TwinThermalSurface[], range: number[] = [15, 35]): TwinBuildingThermal => ({
  photos: [...new Set(surfaces.map((s) => s.photo))].map((photo) => ({
    photo,
    picture: 'vis',
    status: 'ok',
    registration: null,
  })),
  surfaces,
  range,
});

const FRONT_CAM = view(1, 0, 3, 40); // on the ground in front of the block
const FRONT_RIGHT_CAM = view(2, 40, 3, 40);
const ABOVE_CAM = view(3, 0, 60, 15); // a drone: sees the roof

function table(
  surfaces: TwinThermalSurface[],
  parts: TwinBuiltPart[],
  views: TwinBuildingView[] | undefined = [FRONT_CAM, FRONT_RIGHT_CAM, ABOVE_CAM],
  subjectKind: TwinSubjectKind | undefined = 'building',
  unit: 'C' | 'F' = 'C',
): SurfaceTable {
  return buildSurfaceTable(thermal(surfaces), parts, views, subjectKind, unit);
}

function entry(t: SurfaceTable, partName: string, face: TwinFace) {
  const e = t.entries.find((x) => x.part === partName && x.face === face);
  assert.ok(e, `no entry for ${partName}/${face}`);
  return e;
}

const near = (a: number | null, b: number, eps = 1e-6) => {
  assert.ok(a !== null && Math.abs(a - b) < eps, `${a} ≠ ${b}`);
};

// ---- faces --------------------------------------------------------------------------------------------

describe('faceOfNormal', () => {
  it('takes the dominant axis', () => {
    assert.equal(faceOfNormal(0, 0, 1), 'front');
    assert.equal(faceOfNormal(0, 0, -1), 'back');
    assert.equal(faceOfNormal(-1, 0.2, 0.1), 'left');
    assert.equal(faceOfNormal(0.9, 0, 0.1), 'right');
    assert.equal(faceOfNormal(0.1, 0.8, -0.3), 'top');
    assert.equal(faceOfNormal(0, -1, 0), 'bottom');
  });

  it('breaks ties front > right > back > left > top > bottom, as the frame does', () => {
    assert.equal(faceOfNormal(1, 0, 1), 'front');
    assert.equal(faceOfNormal(1, 0, -1), 'right');
    assert.equal(faceOfNormal(-1, 0, -1), 'back');
    assert.equal(faceOfNormal(-1, 1, 0), 'left');
    assert.equal(faceOfNormal(0, 1, -1), 'back');
    assert.equal(faceOfNormal(0, 1, 0), 'top');
    assert.equal(faceOfNormal(0, -1, 1), 'front');
    assert.equal(faceOfNormal(0, 0, 0), 'front');
  });
});

describe('normalizePartName', () => {
  it('lower-cases and keeps letters and digits only', () => {
    assert.equal(normalizePartName('North Wing 2'), 'northwing2');
    assert.equal(normalizePartName('main_Block'), 'mainblock');
  });
});

// ---- orientation --------------------------------------------------------------------------------------

describe('orientation check', () => {
  it('accepts a face the camera looks at, corrects a mirrored one once and drops the rest', () => {
    const t = table(
      [
        surf('block', 'wall', 'front', 1, 21), // seen head-on: fine
        surf('block', 'wall', 'back', 2, 23), // from the front-right the back is hidden; its mirror (front) is not
        surf('block', 'wall', 'left', 1, 19), // edge-on from the front, and so is its mirror: gone
      ],
      [part('block', 'wall')],
    );
    assert.equal(t.stats.flipped, 1);
    assert.equal(t.stats.rejected, 1);
    assert.equal(t.stats.photos, 2);
    // Photo 2's "back" became photo 2's front and agrees with photo 1's front → weighted mean.
    const front = entry(t, 'block', 'front');
    assert.equal(front.status, 'measured');
    near(front.tempC, 22);
  });

  it('does not mirror onto a face the same photo already traced', () => {
    const t = table(
      [surf('block', 'wall', 'front', 2, 21), surf('block', 'wall', 'back', 2, 30)],
      [part('block', 'wall')],
    );
    assert.equal(t.stats.flipped, 0);
    assert.equal(t.stats.rejected, 1);
    near(entry(t, 'block', 'front').tempC, 21);
  });

  it('drops a roof traced from the ground, keeps one traced from above', () => {
    // The camera stands between the block's underside and its top, so neither the roof nor its mirror
    // (the underside) can be what the photo shows: no flip, a plain rejection.
    const fromGround = table([surf('block', 'roof', 'top', 1, 40)], [part('block', 'wall')]);
    assert.equal(fromGround.stats.rejected, 1);
    assert.equal(fromGround.stats.rejectedOrientation, 1);
    assert.equal(fromGround.stats.flipped, 0);
    assert.equal(entry(fromGround, 'block', 'top').status, 'none');
    const fromAbove = table([surf('block', 'roof', 'top', 3, 40)], [part('block', 'wall')]);
    assert.equal(fromAbove.stats.rejected, 0);
    near(entry(fromAbove, 'block', 'top').tempC, 40);
  });

  it("drops a 'bottom' traced from above the part's underside", () => {
    // The ground camera (y 3) is above the block's underside (y 0); the mirror, 'top', needs it above y 10.
    const t = table([surf('block', 'wall', 'bottom', 1, 12)], [part('block', 'wall')]);
    assert.equal(t.stats.rejected, 1);
    assert.equal(t.stats.flipped, 0);
    assert.equal(t.stats.measured, 0);
  });

  it("flips a ceiling's 'top' traced from below it to 'bottom', and a floor's 'bottom' from above to 'top'", () => {
    const ceiling = part('ceiling', 'other', { center: [0, 2.75, 0], min: [-3, 2.7, -3], max: [3, 2.8, 3] });
    const floor = part('floor', 'other', { center: [0, 0.05, 0], min: [-3, 0, -3], max: [3, 0.1, 3] });
    const inRoom = view(1, 0, 1.5, 2);
    const t = table(
      [surf('ceiling', 'other', 'top', 1, 24), surf('floor', 'other', 'bottom', 1, 19)],
      [ceiling, floor],
      [inRoom],
      'interior',
    );
    assert.equal(t.stats.flipped, 2);
    assert.equal(t.stats.rejected, 0);
    const underside = entry(t, 'ceiling', 'bottom');
    assert.equal(underside.status, 'measured');
    near(underside.tempC, 24);
    assert.equal(entry(t, 'ceiling', 'top').status, 'inferred'); // borrowed from the floor's top: same class, same face
    const floorTop = entry(t, 'floor', 'top');
    assert.equal(floorTop.status, 'measured');
    near(floorTop.tempC, 19);
  });

  it('skips the check for a photo without a camera and for a body traced as a whole', () => {
    const t = table(
      [surf('block', 'wall', 'back', 9, 23), surf('drum', 'plastic', 'all', 1, 30)],
      [part('block', 'wall'), part('drum', 'plastic', { round: true })],
    );
    assert.equal(t.stats.rejected, 0);
    near(entry(t, 'block', 'back').tempC, 23);
    near(entry(t, 'drum', 'all').tempC, 30);
  });

  it('counts a surface of a part the program never built as rejected', () => {
    const t = table([surf('annex', 'wall', 'front', 1, 21)], [part('block', 'wall')]);
    assert.equal(t.stats.rejected, 1);
    assert.equal(t.stats.measured, 0);
    assert.equal(t.stats.photos, 0);
  });

  it('matches part names the way the server and the frame do', () => {
    const t = table([surf('Main Block', 'wall', 'front', 1, 21)], [part('mainBlock', 'wall')]);
    near(entry(t, 'mainBlock', 'front').tempC, 21);
  });
});

// ---- aggregation --------------------------------------------------------------------------------------

describe('aggregation across photos', () => {
  it('averages agreeing photos by pixel count', () => {
    const t = table(
      [surf('block', 'wall', 'front', 1, 20, { n: 400 }), surf('block', 'wall', 'front', 9, 21, { n: 200 })],
      [part('block', 'wall')],
    );
    const e = entry(t, 'block', 'front');
    near(e.tempC, (20 * 400 + 21 * 200) / 600);
    assert.equal(e.photo, 1);
    assert.ok(!e.label.includes('over 2 photos'), e.label);
  });

  it('takes the best-sampled photo when they disagree and says so', () => {
    const t = table(
      [surf('block', 'wall', 'front', 1, 20, { n: 100 }), surf('block', 'wall', 'front', 9, 30, { n: 400 })],
      [part('block', 'wall')],
    );
    const e = entry(t, 'block', 'front');
    near(e.tempC, 30);
    assert.equal(e.photo, 9);
    assert.ok(e.label.includes('±5.0 over 2 photos'), e.label);
  });

  it('says "across N traced areas" when the disagreeing readings come from one photo', () => {
    const t = table(
      [surf('block', 'wall', 'front', 1, 20, { n: 100 }), surf('block', 'wall', 'front', 1, 30, { n: 400 })],
      [part('block', 'wall')],
    );
    const e = entry(t, 'block', 'front');
    near(e.tempC, 30);
    assert.ok(!e.label.includes('over 1 photo'), e.label);
    assert.ok(e.label.includes('±5.0 across 2 traced areas'), e.label);
    // Two bands of a boxy part fold into one body: still one photo, two areas.
    const bands = table(
      [surf('block', 'wall', 'upper', 1, 20), surf('block', 'wall', 'lower', 1, 30)],
      [part('block', 'wall')],
    );
    assert.ok(entry(bands, 'block', 'front').label.includes('±5.0 across 2 traced areas · traced as a whole'));
  });

  it('widens the tolerance to 15 % of the scene span', () => {
    // A 50 K scene: two readings 5 K apart are the same surface in different light, not a disagreement.
    const t = table(
      [
        surf('block', 'wall', 'front', 1, 20, { n: 400 }),
        surf('block', 'wall', 'front', 9, 25, { n: 400 }),
        surf('block', 'wall', 'right', 2, 70),
      ],
      [part('block', 'wall')],
    );
    const e = entry(t, 'block', 'front');
    near(e.tempC, 22.5);
    assert.ok(!e.label.includes('over 2 photos'), e.label);
  });
});

// ---- inference: building ------------------------------------------------------------------------------

describe('inference for a building', () => {
  it('(1) borrows from the same kind facing the same way on other parts', () => {
    const t = table(
      [surf('a', 'wall', 'front', 1, 21), surf('b', 'wall', 'front', 1, 23)],
      [part('a', 'wall'), part('b', 'wall'), part('c', 'wall')],
    );
    const e = entry(t, 'c', 'front');
    assert.equal(e.status, 'inferred');
    assert.equal(e.confidence, 'strong');
    near(e.tempC, 22);
    assert.equal(e.label, '22.0 °C · wall · inferred from 2 wall faces facing the same way');
  });

  it("(2) borrows from the part's own sides when they agree within 2 K, and skips them when they do not", () => {
    // Photo 9 has no camera on record, so both sides pass unchecked.
    const agree = table([surf('a', 'wall', 'left', 9, 20), surf('a', 'wall', 'right', 9, 21)], [part('a', 'wall')]);
    const e = entry(agree, 'a', 'back');
    near(e.tempC, 20.5);
    assert.equal(e.label, '20.5 °C · wall · inferred from 2 other faces of this part');

    const split = table(
      [surf('a', 'wall', 'left', 9, 20), surf('a', 'wall', 'right', 9, 26), surf('pillar', 'column', 'back', 9, 24)],
      [part('a', 'wall'), part('pillar', 'column')],
    );
    // (3) the same class facing the same way comes next.
    const back = entry(split, 'a', 'back');
    near(back.tempC, 24);
    assert.equal(back.label, '24.0 °C · wall · inferred from 1 column face facing the same way');
  });

  it('(4) falls back to any side of the same class, weakly', () => {
    const t = table([surf('pillar', 'column', 'right', 2, 24)], [part('a', 'wall'), part('pillar', 'column')]);
    const e = entry(t, 'a', 'back');
    assert.equal(e.confidence, 'weak');
    assert.equal(e.label, '24.0 °C · wall · inferred from 1 column face facing other ways (weak)');
  });

  it('never infers a roof from walls, only from other roofs', () => {
    const walls = table([surf('a', 'wall', 'front', 1, 21), surf('a', 'wall', 'right', 2, 22)], [part('a', 'wall')]);
    assert.equal(entry(walls, 'a', 'top').status, 'none');
    assert.equal(entry(walls, 'a', 'top').label, '— · wall · no measurement');
    const roofs = table(
      [surf('a', 'roof', 'top', 3, 40)],
      [part('a', 'roof', { faces: ['top'] }), part('b', 'roof', { faces: ['top'], center: [20, 5, 0] })],
    );
    const e = entry(roofs, 'b', 'top');
    near(e.tempC, 40);
    assert.equal(e.status, 'inferred');
  });

  it('never crosses a thermal class and has no scene-wide mean', () => {
    const t = table(
      [surf('a', 'wall', 'front', 1, 21), surf('lawn', 'vegetation', 'top', 3, 18)],
      [part('a', 'wall'), part('glazing', 'glass'), part('roadway', 'road', { faces: ['top'] })],
    );
    for (const f of SIX) assert.equal(entry(t, 'glazing', f).status, 'none', f);
    assert.equal(entry(t, 'roadway', 'top').status, 'none');
    // The wall's own top and bottom stay without data too: sides never lend to horizontals.
    assert.equal(entry(t, 'a', 'top').status, 'none');
    assert.equal(t.stats.none, 9);
  });

  it('excludes apparent, mixed and small-area readings as sources', () => {
    const t = table(
      [
        surf('a', 'glass', 'front', 1, 14, { apparent: true }),
        surf('b', 'wall', 'front', 1, 21, { mixed: true }),
        surf('c', 'wall', 'right', 2, 22, { smallSample: true }),
      ],
      [part('a', 'glass'), part('b', 'wall'), part('c', 'wall'), part('d', 'glass'), part('e', 'wall')],
    );
    assert.equal(entry(t, 'a', 'front').status, 'measured');
    assert.equal(entry(t, 'a', 'front').apparent, true);
    assert.equal(entry(t, 'd', 'front').status, 'none');
    assert.equal(entry(t, 'e', 'front').status, 'none');
    assert.equal(entry(t, 'e', 'right').status, 'none');
  });
});

// ---- inference: apparatus -----------------------------------------------------------------------------

describe('inference for apparatus (and a record with no subject kind)', () => {
  const bench = [
    part('kettle', 'plastic', { center: [0, 0.1, 0], min: [-0.1, 0, -0.1], max: [0.1, 0.2, 0.1] }),
    part('lid', 'plastic', { center: [0, 0.22, 0], min: [-0.1, 0.2, -0.1], max: [0.1, 0.24, 0.1] }),
    part('base', 'plastic', { center: [0.5, 0.02, 0], min: [0.4, 0, -0.1], max: [0.6, 0.04, 0.1] }),
  ];

  it("(1) the part's own other faces come first", () => {
    const t = table(
      [surf('kettle', 'plastic', 'front', 9, 60), surf('lid', 'plastic', 'front', 9, 40)],
      bench,
      [],
      'apparatus',
    );
    const e = entry(t, 'kettle', 'back');
    near(e.tempC, 60);
    assert.equal(e.label, '60.0 °C · plastic · inferred from 1 other face of this part');
  });

  it('(2) then the same kind facing the same way, (3) the same kind facing any way, (4) the class weakly', () => {
    const sameFace = table([surf('lid', 'plastic', 'front', 9, 40)], bench, [], undefined);
    assert.equal(
      entry(sameFace, 'kettle', 'front').label,
      '40.0 °C · plastic · inferred from 1 plastic face facing the same way',
    );
    const anyFace = table([surf('lid', 'plastic', 'right', 9, 40)], bench, [], 'apparatus');
    const e = entry(anyFace, 'kettle', 'front');
    assert.equal(e.confidence, 'strong');
    assert.equal(e.label, '40.0 °C · plastic · inferred from 1 plastic face facing other ways');
    const cls = table([surf('lid', 'wood', 'right', 9, 40)], [...bench, part('stand', 'wood')], [], 'vehicle');
    const w = entry(cls, 'kettle', 'front');
    assert.equal(w.confidence, 'weak');
    assert.equal(w.label, '40.0 °C · plastic · inferred from 1 wood face facing other ways (weak)');
  });

  it('keeps metal and glass at "no data" unless traced themselves', () => {
    const t = table([surf('kettle', 'plastic', 'front', 9, 60)], [...bench, part('spout', 'metal')], [], 'apparatus');
    assert.equal(entry(t, 'spout', 'front').status, 'none');
    const traced = table(
      [surf('spout', 'metal', 'front', 9, 55, { apparent: true })],
      [part('spout', 'metal')],
      [],
      'apparatus',
    );
    assert.equal(
      entry(traced, 'spout', 'front').label,
      '55.0 °C · metal · apparent (low emissivity, likely reads low) · photo 9',
    );
    // A metal part's own other faces do not borrow either: its one reading is apparent.
    assert.equal(entry(traced, 'spout', 'back').status, 'none');
  });
});

// ---- round parts and bodies traced as a whole ---------------------------------------------------------

describe('round parts', () => {
  const drum = part('drum', 'plastic', { round: true });

  it("owe 'all' plus the bands that were traced; a traced side folds into 'all'", () => {
    const t = table(
      [surf('drum', 'plastic', 'upper', 9, 70), surf('drum', 'plastic', 'front', 9, 60)],
      [drum],
      [],
      'apparatus',
    );
    assert.deepEqual(
      t.entries.map((e) => e.face),
      ['all', 'upper'],
    );
    near(entry(t, 'drum', 'all').tempC, 60);
    near(entry(t, 'drum', 'upper').tempC, 70);
  });

  it("infer a missing 'all' from the traced bands", () => {
    const t = table(
      [surf('drum', 'plastic', 'lower', 9, 30), surf('drum', 'plastic', 'upper', 9, 32)],
      [drum],
      [],
      'apparatus',
    );
    const e = entry(t, 'drum', 'all');
    assert.equal(e.status, 'inferred');
    near(e.tempC, 31);
  });

  it("keep a traced top and bottom as their own faces instead of folding them into 'all'", () => {
    // A hot plate seen from the drone: its top is 200 °C, its rim 60 °C. Two entries, both measured.
    const t = table(
      [surf('hotPlate', 'plastic', 'top', 3, 200, { n: 300 }), surf('hotPlate', 'plastic', 'front', 3, 60)],
      [part('hotPlate', 'plastic', { round: true })],
      undefined,
      'apparatus',
    );
    assert.deepEqual(
      t.entries.map((e) => e.face),
      ['all', 'top'],
    );
    const side = entry(t, 'hotPlate', 'all');
    assert.equal(side.status, 'measured');
    near(side.tempC, 60);
    const top = entry(t, 'hotPlate', 'top');
    assert.equal(top.status, 'measured');
    assert.equal(top.confidence, 'strong');
    near(top.tempC, 200);
    assert.equal(top.cameras, undefined); // a single face needs no camera split
  });

  it("carry the cameras that traced the body on the 'all' and band entries, with a far-side label", () => {
    const t = table([surf('drum', 'metal', 'front', 1, 21.3, { apparent: true })], [drum], undefined, 'apparatus');
    const e = entry(t, 'drum', 'all');
    assert.equal(e.status, 'measured');
    assert.equal(e.confidence, 'strong');
    assert.deepEqual(e.cameras, [[FRONT_CAM.x, FRONT_CAM.y, FRONT_CAM.z]]);
    assert.equal(
      e.farLabel,
      '21.3 °C · metal · apparent (low emissivity, likely reads low) · far side, inferred from this part traced as a whole',
    );
    // Two photos of the upper band: both cameras, once each.
    const band = table(
      [surf('drum', 'plastic', 'upper', 1, 70), surf('drum', 'plastic', 'upper', 2, 71)],
      [drum],
      undefined,
      'apparatus',
    );
    const u = entry(band, 'drum', 'upper');
    assert.deepEqual(u.cameras, [
      [FRONT_CAM.x, FRONT_CAM.y, FRONT_CAM.z],
      [FRONT_RIGHT_CAM.x, FRONT_RIGHT_CAM.y, FRONT_RIGHT_CAM.z],
    ]);
    assert.equal(u.farLabel, "70.5 °C · plastic · far side, inferred from this part's upper band");
  });

  it('measure the whole body weakly, without cameras, when no contributing photo has a camera', () => {
    const t = table([surf('drum', 'plastic', 'front', 9, 60)], [drum], [], 'apparatus');
    const e = entry(t, 'drum', 'all');
    assert.equal(e.status, 'measured');
    assert.equal(e.confidence, 'weak');
    assert.ok(e.label.endsWith('(weak)'), e.label);
    assert.equal(e.cameras, undefined);
    assert.equal(e.farLabel, undefined);
  });
});

describe("a boxy part traced as 'all'", () => {
  it('measures the faces that photo saw and only lends the value to the faces it did not', () => {
    const t = table([surf('block', 'wall', 'all', 1, 21)], [part('block', 'wall')]);
    const front = entry(t, 'block', 'front');
    assert.equal(front.status, 'measured');
    assert.equal(front.confidence, 'strong');
    assert.ok(front.label.endsWith('· traced as a whole'), front.label);
    const back = entry(t, 'block', 'back');
    assert.equal(back.status, 'inferred');
    assert.equal(back.confidence, 'weak');
    assert.equal(back.label, '21.0 °C · wall · inferred from this part traced as a whole (weak)');
    assert.equal(entry(t, 'block', 'top').status, 'inferred');
    // The ground camera (y 3) is above the underside: the bottom was not in the photo either.
    assert.equal(entry(t, 'block', 'bottom').status, 'inferred');
    assert.equal(entry(t, 'block', 'bottom').confidence, 'weak');
    assert.equal(t.stats.measured, 1);
  });

  it('does not call a top measured from a camera below it, nor a bottom from a camera above it', () => {
    // A 30 m tower traced as a whole from mid-height (y 20): the dot product against the centre (y 15)
    // says the top faces the camera, but the roof is above the camera — sky.
    const tower = part('tower', 'wall', { center: [0, 15, 0], min: [-5, 0, -5], max: [5, 30, 5] });
    const midHeight = table([surf('tower', 'wall', 'all', 1, 21)], [tower], [view(1, 0, 20, 30)]);
    const top = entry(midHeight, 'tower', 'top');
    assert.equal(top.status, 'inferred');
    assert.equal(top.confidence, 'weak');
    assert.equal(entry(midHeight, 'tower', 'front').status, 'measured');
    const bottom = entry(midHeight, 'tower', 'bottom');
    assert.equal(bottom.status, 'inferred');
    // A drone above the roof does see it; a camera below the underside sees that instead.
    const fromAbove = table([surf('tower', 'wall', 'all', 1, 21)], [tower], [view(1, 0, 40, 30)]);
    assert.equal(entry(fromAbove, 'tower', 'top').status, 'measured');
    assert.equal(entry(fromAbove, 'tower', 'bottom').status, 'inferred');
    const fromBelow = table([surf('tower', 'wall', 'all', 1, 21)], [tower], [view(1, 0, -10, 30)]);
    assert.equal(entry(fromBelow, 'tower', 'bottom').status, 'measured');
    assert.equal(entry(fromBelow, 'tower', 'top').status, 'inferred');
  });

  it('measures every face, weakly, when no camera is on record', () => {
    const t = table([surf('block', 'wall', 'all', 9, 21)], [part('block', 'wall')], []);
    for (const f of SIX) {
      const e = entry(t, 'block', f);
      assert.equal(e.status, 'measured', f);
      assert.equal(e.confidence, 'weak', f);
      assert.ok(e.label.endsWith('(weak)'), e.label);
    }
  });

  it('lets an explicitly traced face win over the whole-body reading', () => {
    const t = table(
      [surf('block', 'wall', 'all', 1, 21), surf('block', 'wall', 'front', 1, 25)],
      [part('block', 'wall')],
    );
    near(entry(t, 'block', 'front').tempC, 25);
    assert.equal(entry(t, 'block', 'front').confidence, 'strong');
  });
});

// ---- labels -------------------------------------------------------------------------------------------

describe('labels', () => {
  const reading = surf('block', 'wall', 'front', 3, 21.3, { n: 412, p10: 19.8, p90: 23.9 });

  it('word a measurement in °C and in °F', () => {
    const c = table([reading], [part('block', 'wall')]);
    assert.equal(entry(c, 'block', 'front').label, '21.3 °C · wall · measured · photo 3 · n=412 · p10–p90 19.8–23.9');
    const f = table([reading], [part('block', 'wall')], undefined, 'building', 'F');
    assert.equal(entry(f, 'block', 'front').label, '70.3 °F · wall · measured · photo 3 · n=412 · p10–p90 67.6–75.0');
    // The value itself stays °C: the frame's colour scale is °C.
    near(entry(f, 'block', 'front').tempC, 21.3);
  });

  it('flag small areas and mixed surfaces', () => {
    const t = table([{ ...reading, smallSample: true, mixed: true }], [part('block', 'wall')]);
    assert.ok(entry(t, 'block', 'front').label.endsWith('· small area · mixed surface'));
  });

  it('say what an apparent reading is', () => {
    const t = table([surf('pane', 'glass', 'front', 2, 14.2, { apparent: true })], [part('pane', 'glass')]);
    assert.equal(entry(t, 'pane', 'front').label, '14.2 °C · glass · apparent (reflects sky/surroundings) · photo 2');
  });

  it('convert a disagreement spread as a difference in °F', () => {
    const t = table(
      [surf('block', 'wall', 'front', 1, 20, { n: 100 }), surf('block', 'wall', 'front', 9, 30, { n: 400 })],
      [part('block', 'wall')],
      undefined,
      'building',
      'F',
    );
    assert.ok(entry(t, 'block', 'front').label.includes('±9.0 over 2 photos'), entry(t, 'block', 'front').label);
  });

  it('write "no measurement" with the part kind', () => {
    const t = buildSurfaceTable(null, [part('roof', 'roof', { faces: ['top'] })], undefined, 'building', 'C');
    assert.equal(t.entries.length, 1);
    assert.equal(t.entries[0].label, '— · roof · no measurement');
    assert.equal(t.entries[0].tempC, null);
  });
});

// ---- scale --------------------------------------------------------------------------------------------

describe('range and slider bounds', () => {
  it('spans the measured values with a kelvin to spare and at least 4 K', () => {
    const one = table([surf('block', 'wall', 'front', 1, 21.3)], [part('block', 'wall')]);
    assert.deepEqual(one.range, [19.5, 23.5]);
    const two = table(
      [surf('block', 'wall', 'front', 1, 20), surf('block', 'wall', 'right', 2, 30)],
      [part('block', 'wall')],
    );
    assert.deepEqual(two.range, [19, 31]);
  });

  it('falls back to the stored range, then to 15–35 °C', () => {
    const stored = buildSurfaceTable(thermal([], [10, 20]), [part('block', 'wall')], [], 'building', 'C');
    assert.deepEqual(stored.range, [10, 20]);
    const rejectedOnly = buildSurfaceTable(
      thermal([surf('block', 'roof', 'top', 1, 40)], [0, 0]),
      [part('block', 'wall')],
      [FRONT_CAM],
      'building',
      'C',
    );
    assert.deepEqual(rejectedOnly.range, [15, 35]);
    assert.deepEqual(buildSurfaceTable(null, [], undefined, undefined, 'C').range, [15, 35]);
  });

  it('lets the slider reach 10 K beyond the widest p10–p90, within −40…400 °C', () => {
    const t = table(
      [surf('block', 'wall', 'front', 1, 25, { p10: 18.2, p90: 31.7 }), surf('block', 'wall', 'right', 2, 26)],
      [part('block', 'wall')],
    );
    assert.deepEqual(t.sliderBounds, [8, 42]);
    const cold = table([surf('block', 'wall', 'front', 1, -30, { p10: -45, p90: 395 })], [part('block', 'wall')]);
    assert.deepEqual(cold.sliderBounds, [-40, 400]);
    assert.deepEqual(buildSurfaceTable(null, [], undefined, undefined, 'C').sliderBounds, [5, 45]);
  });

  it('counts what it built', () => {
    const t = table(
      [surf('a', 'wall', 'front', 1, 21), surf('a', 'wall', 'back', 2, 23), surf('b', 'wall', 'front', 9, 22)],
      [part('a', 'wall'), part('b', 'wall'), part('pane', 'glass')],
    );
    // a: front measured, back flipped onto front (already measured → merged), b: front measured; each
    // wall's three other sides are inferred from its front, the tops and bottoms and the pane stay empty.
    assert.deepEqual(t.stats, {
      measured: 2,
      inferred: 6,
      none: 10,
      rejected: 0,
      rejectedNoPart: 0,
      rejectedOrientation: 0,
      unplaced: 0,
      unknownParts: 0,
      flipped: 1,
      photos: 3,
      filled: 0,
    });
    assert.equal(t.entries.length, 18);
  });

  it('tells a part-name mismatch from a camera rejection and counts the unknown names', () => {
    const t = table(
      [
        surf('annex', 'wall', 'front', 1, 21), // never built
        surf('Annex', 'wall', 'right', 2, 22), // the same unknown name, spelt differently
        surf('tower', 'wall', 'front', 1, 20), // never built either
        surf('block', 'wall', 'left', 1, 19), // edge-on from the front: a camera problem, not a naming one
      ],
      [part('block', 'wall')],
    );
    assert.equal(t.stats.rejectedNoPart, 3);
    assert.equal(t.stats.unknownParts, 2);
    assert.equal(t.stats.rejectedOrientation, 1);
    assert.equal(t.stats.rejected, 4);
    assert.equal(t.stats.unplaced, 0);
  });

  it('counts an accepted surface on a face the frame never saw for that part as unplaced', () => {
    // A single-sided slab: the frame reports only 'front', and photo 9 has no camera to reject the 'back'.
    const t = table([surf('slab', 'wall', 'back', 9, 21)], [part('slab', 'wall', { faces: ['front'] })]);
    assert.equal(t.stats.rejected, 0);
    assert.equal(t.stats.unplaced, 1);
    assert.equal(t.stats.measured, 0);
    assert.equal(t.entries.length, 1);
  });
});

// ---- scenery ------------------------------------------------------------------------------------------

describe('unnamed scenery', () => {
  it('gets "not part of the subject" entries, borrows nothing and is left out of the counts', () => {
    const t = table([surf('block', 'wall', 'front', 1, 21)], [part('block', 'wall'), part('unnamed', 'wall')]);
    const scenery = t.entries.filter((e) => e.part === 'unnamed');
    assert.equal(scenery.length, 6);
    for (const e of scenery) {
      assert.equal(e.status, 'none');
      assert.equal(e.tempC, null);
      assert.equal(e.label, '— · wall · scenery · not part of the subject');
    }
    // The block alone: front measured, three sides inferred from it, top and bottom without data.
    assert.equal(t.stats.measured, 1);
    assert.equal(t.stats.inferred, 3);
    assert.equal(t.stats.none, 2);
    assert.equal(t.entries.length, 12);
  });
});

// ---- the all-inferred fill ----------------------------------------------------------------------------

describe('the all-inferred fill', () => {
  const tableAll = (
    surfaces: TwinThermalSurface[],
    parts: TwinBuiltPart[],
    views: TwinBuildingView[] | undefined = [FRONT_CAM, FRONT_RIGHT_CAM, ABOVE_CAM],
    subjectKind: TwinSubjectKind | undefined = 'building',
  ) => buildSurfaceTable(thermal(surfaces), parts, views, subjectKind, 'C', 'photos', 'all');
  // The class-barrier scene: a wall's front and a lawn's top measured; glass and a road never traced.
  const surfaces = [surf('a', 'wall', 'front', 1, 21), surf('lawn', 'vegetation', 'top', 3, 18)];
  const parts = [
    part('a', 'wall'),
    part('lawn', 'vegetation', { faces: ['top'] }),
    part('glazing', 'glass'),
    part('roadway', 'road', { faces: ['top'] }),
  ];

  it('gives every face a value from the readings, weak, and counts what only the fill gave', () => {
    const t = tableAll(surfaces, parts);
    for (const e of t.entries) {
      assert.notEqual(e.status, 'none', `${e.part}/${e.face}`);
      assert.ok(e.tempC !== null && Number.isFinite(e.tempC));
    }
    assert.equal(t.stats.none, 0);
    // The wall's sides came by the comparable rules; its top and bottom, the six glass faces and the
    // road's top only by the fill.
    assert.equal(t.stats.measured, 2);
    assert.equal(t.stats.inferred, 12);
    assert.equal(t.stats.filled, 9);
    for (const e of t.entries) if (e.status === 'inferred' && e.part !== 'a') assert.equal(e.confidence, 'weak');
  });

  it("fills a top from the part's own sides before anything else, and says so", () => {
    const t = tableAll(surfaces, parts);
    const top = entry(t, 'a', 'top');
    near(top.tempC, 21);
    assert.equal(top.label, '21.0 °C · wall · inferred from 1 other face of this part facing other ways (weak)');
    // The comparable rules' own inferences read as before.
    assert.equal(entry(t, 'a', 'back').label, '21.0 °C · wall · inferred from 1 other face of this part');
  });

  it('crosses classes only when nothing of the class was measured, facing the same way first', () => {
    const t = tableAll(surfaces, parts);
    // Glass sides from the wall's front, the road's and the glass's top from the lawn's top, the glass's
    // bottom (no bottom anywhere) from every reading of the scene.
    near(entry(t, 'glazing', 'front').tempC, 21);
    assert.equal(
      entry(t, 'glazing', 'front').label,
      '21.0 °C · glass · inferred from 1 wall face facing the same way · nothing of the same material measured (weak)',
    );
    near(entry(t, 'roadway', 'top').tempC, 18);
    assert.match(entry(t, 'roadway', 'top').label, /inferred from 1 vegetation face facing the same way/);
    near(entry(t, 'glazing', 'bottom').tempC, 19.5);
    assert.equal(
      entry(t, 'glazing', 'bottom').label,
      '19.5 °C · glass · inferred from every measured face of the scene (2 wall/vegetation faces) · nothing of the same material measured (weak)',
    );
  });

  it('reaches for apparent, mixed and small-area readings of the same class before crossing it', () => {
    const t = tableAll(
      [
        surf('a', 'glass', 'front', 1, 14, { apparent: true }),
        surf('b', 'wall', 'front', 1, 21, { mixed: true }),
        surf('c', 'wall', 'right', 2, 22, { smallSample: true }),
      ],
      [part('a', 'glass'), part('b', 'wall'), part('c', 'wall'), part('d', 'glass'), part('e', 'wall')],
    );
    // Glass from the glass's apparent reading (not from the walls' clean-er 21), apparent itself.
    const d = entry(t, 'd', 'front');
    near(d.tempC, 14);
    assert.equal(d.apparent, true);
    assert.equal(
      d.label,
      '14.0 °C · glass · apparent (reflects sky/surroundings) · inferred from 1 glass face facing the same way (weak)',
    );
    // A wall from the walls' doubtful readings, which the label owns up to.
    const e = entry(t, 'e', 'front');
    near(e.tempC, 21.5);
    assert.equal(e.apparent, undefined);
    assert.equal(
      e.label,
      '21.5 °C · wall · inferred from 2 wall faces facing the same way · mixed-surface/small-area readings (weak)',
    );
    near(entry(t, 'e', 'top').tempC, 21.5);
    assert.match(entry(t, 'e', 'top').label, /facing other ways · mixed-surface\/small-area readings \(weak\)$/);
    assert.equal(t.stats.none, 0);
  });

  it('paints unnamed scenery and the ground, marked as scenery and still out of the counts', () => {
    const t = tableAll([surf('block', 'wall', 'front', 1, 21)], [part('block', 'wall'), part('unnamed', 'wall')]);
    const scenery = t.entries.filter((e) => e.part === 'unnamed');
    assert.equal(scenery.length, 6);
    for (const e of scenery) {
      assert.equal(e.status, 'inferred');
      near(e.tempC, 21);
      assert.match(e.label, /^21\.0 °C · wall · scenery · inferred from /);
    }
    assert.equal(t.stats.measured, 1);
    assert.equal(t.stats.inferred, 5);
    assert.equal(t.stats.filled, 2);
    assert.equal(t.stats.none, 0);
    assert.ok(t.ground);
    near(t.ground.tempC, 21);
    assert.equal(
      t.ground.label,
      '21.0 °C · ground · scenery · inferred from every measured face of the scene (1 wall face) · nothing of the same material measured (weak)',
    );
  });

  it('gives the ground the site readings when there are any', () => {
    const t = tableAll(
      [surf('a', 'wall', 'front', 1, 21), surf('drive', 'pavement', 'top', 3, 30)],
      [part('a', 'wall'), part('drive', 'pavement', { faces: ['top'] })],
    );
    assert.ok(t.ground);
    near(t.ground.tempC, 30);
    assert.equal(
      t.ground.label,
      '30.0 °C · ground · scenery · inferred from the ground cover measured (1 pavement face), weighted by the area each was read over (weak)',
    );
  });

  it('counts a lawn as ground cover, weighing each reading by its area, never a doubtful one', () => {
    // A street baked to 40 °C in front of a house on a 30 °C lawn: the plane round the model is mostly lawn.
    const t = tableAll(
      [
        surf('house', 'wall', 'front', 1, 21),
        surf('road', 'road', 'top', 3, 40, { n: 100 }),
        surf('lawn', 'vegetation', 'top', 3, 30, { n: 300 }),
        surf('verge', 'pavement', 'top', 3, 60, { n: 300, mixed: true }),
      ],
      [
        part('house', 'wall'),
        part('road', 'road', { faces: ['top'] }),
        part('lawn', 'vegetation', { faces: ['top'] }),
        part('verge', 'pavement', { faces: ['top'] }),
      ],
    );
    assert.ok(t.ground);
    near(t.ground.tempC, 32.5); // (40·100 + 30·300) / 400; the mixed verge left out
    assert.match(t.ground.label, /^32\.5 °C · ground · scenery · inferred from the ground cover measured \(2 /);
  });

  it('changes nothing outside the fill, and fills nothing without a reading', () => {
    const t = table(surfaces, parts);
    assert.equal(t.stats.filled, 0);
    assert.equal(t.stats.none, 9);
    assert.equal(t.ground, null);
    const empty = buildSurfaceTable(null, parts, undefined, 'building', 'C', 'photos', 'all');
    assert.equal(empty.stats.none, 14);
    assert.equal(empty.stats.filled, 0);
    assert.equal(empty.ground, null);
  });
});

// ---- records with face textures -----------------------------------------------------------------------

describe('a record with face textures', () => {
  it('ignores them: the face is one value, like any other', () => {
    // Records of 2026-09-11 carried a `tex` per surface — the face's own pixels, since replaced by
    // projecting the photos (§18.8). It is no longer part of the contract, and must change nothing.
    const older = Object.assign(surf('a', 'wall', 'front', 1, 21), {
      tex: { w: 2, h: 2, lo: 20, hi: 30, data: Buffer.from([0, 255, 51, 204]).toString('base64') },
    });
    const t = table([older], [part('a', 'wall')]);
    const e = entry(t, 'a', 'front');
    assert.equal(e.status, 'measured');
    near(e.tempC, 21);
    assert.equal(e.label, entry(table([surf('a', 'wall', 'front', 1, 21)], [part('a', 'wall')]), 'a', 'front').label);
    assert.ok(!('tile' in e), 'the entry carries no tile');
    assert.ok(!('textured' in t.stats), 'the stats count no textures');
  });
});

// ---- palettes -----------------------------------------------------------------------------------------

describe('paletteLut256', () => {
  it('resamples any LUT to 256 stops keeping both ends', () => {
    for (const key of ['iron', 'arctic', 'rainhc', 'lava']) {
      const lut = paletteLut256(key);
      const src = PALETTE_COLORS[key];
      assert.equal(lut.length, 256, key);
      assert.equal(lut[0], src[0], key);
      assert.equal(lut[255], src[src.length - 1], key);
      assert.equal(lut[128], src[Math.round((128 / 255) * (src.length - 1))], key);
    }
  });

  it('falls back to iron for the cyclic colorwheel6 and for keys it does not know', () => {
    const iron = paletteLut256('iron');
    assert.deepEqual(paletteLut256('colorwheel6'), iron);
    assert.deepEqual(paletteLut256('nope'), iron);
    assert.deepEqual(paletteLut256(null), iron);
    assert.deepEqual(paletteLut256(undefined), iron);
  });
});

describe('paletteKeyFor', () => {
  it("prefers the set's palette, then the first photo palette on record, then iron", () => {
    assert.equal(paletteKeyFor({ palette: 'RainHC' }), 'rainhc');
    assert.equal(paletteKeyFor({ photoPalettes: [null, 'Lava', 'Iron'] }), 'lava');
    assert.equal(paletteKeyFor({ palette: 'Sepia', photoPalettes: ['Arctic'] }), 'arctic');
    assert.equal(paletteKeyFor({ photoPalettes: [null, 'Sepia'] }), 'iron');
    assert.equal(paletteKeyFor({}), 'iron');
  });
});
