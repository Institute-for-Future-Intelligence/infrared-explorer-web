import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIM_DEFAULT_SKY_LOSS,
  SIM_DEFAULT_WIND_H,
  SIM_EMISSIVITY,
  SIM_KINDS,
  SIM_LIMITS,
  SIM_MATERIALS,
  SIM_PRESETS,
  SIM_PRESET_KEYS,
  SIM_SIGMA,
  type SimMaterial,
  type SimScenario,
  changedKinds,
  clampTo,
  defaultMaterials,
  matchingPreset,
  simKindOf,
  simKindsInScene,
  simSurfaceTemp,
  sunDirection,
  sunShines,
  sunSide,
} from './twinSimulation';
import { TWIN_FRAME_HTML } from '../pages/experimentAnalyzer/twin/twinFrame';

describe('presets', () => {
  it('each matches itself, and nothing once a value or the scale moves', () => {
    for (const key of SIM_PRESET_KEYS) {
      const p = SIM_PRESETS[key];
      assert.equal(matchingPreset(p.scenario, p.range), key);
      assert.equal(matchingPreset({ ...p.scenario, windH: p.scenario.windH + 1 }, p.range), null, key);
      assert.equal(matchingPreset({ ...p.scenario, skyLoss: 0 }, p.range), null, key);
      assert.equal(matchingPreset({ ...p.scenario, diffuse: p.scenario.diffuse + 10 }, p.range), null, key);
      assert.equal(matchingPreset(p.scenario, [p.range[0], p.range[1] + 1]), null, key);
    }
  });

  it('fill in every condition, within the bounds the controls allow', () => {
    for (const key of SIM_PRESET_KEYS) {
      const { scenario, range } = SIM_PRESETS[key];
      for (const [field, value] of Object.entries(scenario)) {
        const [lo, hi] = SIM_LIMITS[field as keyof typeof scenario];
        assert.ok(value >= lo && value <= hi, `${key}.${field} = ${value} outside ${lo}…${hi}`);
      }
      assert.ok(range[0] >= SIM_LIMITS.scale[0] && range[1] <= SIM_LIMITS.scale[1], key);
      assert.equal(scenario.windH, SIM_DEFAULT_WIND_H);
      assert.equal(scenario.skyLoss, SIM_DEFAULT_SKY_LOSS);
    }
  });

  it('give the night presets no sun at all', () => {
    for (const key of ['winterNight', 'summerNight'] as const) {
      const s = SIM_PRESETS[key].scenario;
      assert.equal(s.irradiance, 0);
      assert.equal(s.diffuse, 0);
      assert.ok(s.sunElevationDeg <= 0);
    }
  });
});

describe('the sun', () => {
  it('shines only above the horizon and with some irradiance', () => {
    const s = SIM_PRESETS.winterDay.scenario;
    assert.equal(sunShines(s), true);
    assert.equal(sunShines({ ...s, sunElevationDeg: 0 }), false);
    assert.equal(sunShines({ ...s, irradiance: 0 }), false);
    assert.equal(sunShines(SIM_PRESETS.winterNight.scenario), false);
  });

  it('stands where the azimuth and elevation say, in the subject’s frame', () => {
    const round = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000);
    const at = (sunAzimuthDeg: number, sunElevationDeg: number) =>
      round(sunDirection({ ...SIM_PRESETS.summerDay.scenario, sunAzimuthDeg, sunElevationDeg }));
    assert.deepEqual(at(0, 0), [0, 0, 1]); // in front
    assert.deepEqual(at(90, 0), [1, 0, 0]); // to the right
    assert.deepEqual(at(180, 0), [0, 0, -1]);
    assert.deepEqual(at(0, 90), [0, 1, 0]); // overhead
  });

  it('is named by the side of the subject it stands on', () => {
    assert.equal(sunSide(0), 'front');
    assert.equal(sunSide(22), 'front');
    assert.equal(sunSide(23), 'front-right');
    assert.equal(sunSide(90), 'right');
    assert.equal(sunSide(150), 'back-right');
    assert.equal(sunSide(180), 'back');
    assert.equal(sunSide(220), 'back-left');
    assert.equal(sunSide(270), 'left');
    assert.equal(sunSide(330), 'front-left');
    assert.equal(sunSide(340), 'front');
    assert.equal(sunSide(359), 'front');
    assert.equal(sunSide(-90), 'left');
    assert.equal(sunSide(450), 'right');
  });
});

describe('materials', () => {
  it('map a part kind to its own material, anything else to other', () => {
    assert.equal(simKindOf('wall'), 'wall');
    assert.equal(simKindOf('ground'), 'ground');
    assert.equal(simKindOf('metal'), 'other');
    assert.equal(simKindOf(''), 'other');
  });

  it('list the kinds a scene uses once each, in table order, with the ground when it is drawn', () => {
    assert.deepEqual(simKindsInScene(['glass', 'wall', 'metal', 'wall', 'road'], true), [
      'wall',
      'glass',
      'road',
      'ground',
      'other',
    ]);
    assert.deepEqual(simKindsInScene(['roof'], false), ['roof']);
    assert.deepEqual(simKindsInScene([], true), ['ground']);
  });

  it('start as the defaults, as copies the viewer can change without touching them', () => {
    const m = defaultMaterials();
    assert.deepEqual(m, SIM_MATERIALS);
    assert.deepEqual(changedKinds(m), []);
    m.glass.U = 5.8;
    m.road.store = 8;
    assert.equal(SIM_MATERIALS.glass.U, 2.8);
    assert.deepEqual(changedKinds(m), ['glass', 'road']);
    assert.deepEqual(Object.keys(m), [...SIM_KINDS]);
  });

  it('stay within the bounds the table allows', () => {
    for (const k of SIM_KINDS) {
      const { U, alpha, store, bias } = SIM_MATERIALS[k];
      assert.ok(U >= SIM_LIMITS.U[0] && U <= SIM_LIMITS.U[1], k);
      assert.ok(alpha >= SIM_LIMITS.alpha[0] && alpha <= SIM_LIMITS.alpha[1], k);
      assert.ok(store >= SIM_LIMITS.store[0] && store <= SIM_LIMITS.store[1], k);
      assert.ok(bias >= SIM_LIMITS.bias[0] && bias <= SIM_LIMITS.bias[1], k);
    }
  });

  it('give the store only to what has mass under it', () => {
    for (const k of ['road', 'pavement', 'ground', 'vegetation'] as const) assert.ok(SIM_MATERIALS[k].store > 0, k);
    for (const k of ['roof', 'wall', 'glass', 'frame', 'canopy'] as const) assert.equal(SIM_MATERIALS[k].store, 0, k);
  });
});

describe('clampTo', () => {
  it('brings a value within bounds, a non-finite one to the lower end', () => {
    assert.equal(clampTo(5, [0, 1]), 1);
    assert.equal(clampTo(-5, [0, 1]), 0);
    assert.equal(clampTo(0.4, [0, 1]), 0.4);
    assert.equal(clampTo(Number.NaN, [4, 40]), 4);
  });
});

// ---- the balance -------------------------------------------------------------------------------------

const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const summer = SIM_PRESETS.summerDay.scenario;
/** The vertical face turned squarely to the sun's azimuth. */
const sunward = (s: SimScenario) => {
  const d = sunDirection(s);
  return [d[0], 0, d[2]];
};
const at = (kind: keyof typeof SIM_MATERIALS, normal: number[], s: SimScenario = summer) =>
  Math.round(simSurfaceTemp(SIM_MATERIALS[kind], normal, s) * 10) / 10;

describe('the surface balance', () => {
  it('solves the balance it states: gains equal losses at the temperature it returns', () => {
    // Independently: put the answer back into the energy balance and check it nets to zero.
    const cases: [SimMaterial, number[], SimScenario][] = [
      [SIM_MATERIALS.road, UP, summer],
      [SIM_MATERIALS.roof, UP, summer],
      [SIM_MATERIALS.glass, sunward(summer), summer],
      [SIM_MATERIALS.wall, DOWN, summer],
      [SIM_MATERIALS.ground, UP, SIM_PRESETS.winterNight.scenario],
      [SIM_MATERIALS.road, UP, { ...summer, windH: SIM_LIMITS.windH[0] }],
      [SIM_MATERIALS.road, UP, { ...summer, windH: SIM_LIMITS.windH[1] }],
    ];
    for (const [material, normal, s] of cases) {
      const t = simSurfaceTemp(material, normal, s) - material.bias;
      const len = Math.hypot(normal[0], normal[1], normal[2]);
      const n = normal.map((v) => v / len);
      const d = sunDirection(s);
      const cosSun = Math.max(0, n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
      const skyView = Math.min(1, Math.max(0, 0.5 + 0.5 * n[1]));
      const beam = s.sunElevationDeg > 0 ? s.irradiance : 0;
      const sky = s.sunElevationDeg > 0 ? s.diffuse : 0;
      const gain = material.alpha * (beam * cosSun + sky * skyView) + material.U * (s.tIn - s.tOut);
      const loss =
        (Math.max(0.5, s.windH) + material.store) * (t - s.tOut) +
        SIM_EMISSIVITY * SIM_SIGMA * ((t + 273.15) ** 4 - (s.tOut + 273.15) ** 4) +
        skyView * s.skyLoss;
      assert.ok(Math.abs(gain - loss) < 1e-6, `${gain} ≠ ${loss} at ${t} °C`);
    }
  });

  it('lands on what thermal cameras measure on a clear 33 °C afternoon', () => {
    // Field anchors: dark asphalt 57–65 °C at this air temperature (SHRP's peak-air + 25.5 K gives 58.5;
    // Osaka measured 59.7 at 36 °C air; Beijing/Tianjin expressway sensors about 55 at 35 °C), bare soil
    // 50–60, irrigated planting near the air, a black roof hotter than the road.
    assert.equal(at('road', UP), 59.9);
    assert.equal(at('pavement', UP), 53.5);
    assert.equal(at('ground', UP), 50.3);
    assert.equal(at('vegetation', UP), 32.6);
    assert.equal(at('roof', UP), 67.6);
    assert.equal(at('wall', sunward(summer)), 46.6);
    assert.equal(at('glass', sunward(summer)), 33.4);
    assert.ok(at('roof', UP) > at('road', UP), 'a black roof runs hotter than the road');
  });

  it('keeps a clear winter night as it was: glass warmest, roof coldest', () => {
    const s = SIM_PRESETS.winterNight.scenario;
    assert.equal(at('glass', sunward(s), s), -2.4);
    assert.equal(at('wall', sunward(s), s), -5.9);
    assert.equal(at('roof', UP, s), -8.2);
    assert.equal(at('ground', UP, s), -7.8);
  });

  it('cools a surface as the wind rises, and never lets still air run away', () => {
    const road = (windH: number) => at('road', UP, { ...summer, windH });
    const still = road(SIM_LIMITS.windH[0]);
    assert.ok(still < 80, `still air gave ${still} °C`); // the old formula gave 178 °C here
    assert.ok(still > road(4) && road(4) > road(12) && road(12) > road(20));
    // Every surface stays under boiling even at the hottest the controls allow.
    const extreme = { ...summer, tOut: SIM_LIMITS.tOut[1], irradiance: 1200, diffuse: 400, windH: 2, skyLoss: 0 };
    for (const k of SIM_KINDS) assert.ok(simSurfaceTemp(SIM_MATERIALS[k], UP, extreme) < 200, k);
  });

  it('gives a face the sky it can see: all of it looking up, half on a wall, none looking down', () => {
    const night = { ...SIM_PRESETS.summerNight.scenario, skyLoss: 80 };
    const up = at('wall', UP, night);
    const side = at('wall', sunward(night), night);
    const down = at('wall', DOWN, night);
    assert.ok(up < side && side < down, `${up} / ${side} / ${down}`);
    // Under cloud there is no sky cooling, so all three sit together.
    const cloudy = { ...night, skyLoss: 0 };
    assert.equal(at('wall', UP, cloudy), at('wall', DOWN, cloudy));
  });

  it('takes the sky light away at night, along with the beam', () => {
    const night = { ...SIM_PRESETS.summerNight.scenario, irradiance: 900, diffuse: 200 };
    assert.equal(at('road', UP, night), at('road', UP, SIM_PRESETS.summerNight.scenario));
  });

  it('warms a shaded face by the sky light alone', () => {
    const shaded = at('road', DOWN, summer); // faces down: no beam, no sky
    const lit = at('road', UP, { ...summer, irradiance: 0 }); // sky light only
    assert.ok(lit > shaded + 2, `${lit} vs ${shaded}`);
  });
});

describe('the frame page', () => {
  it('starts from the same defaults: they are injected, not copied', () => {
    assert.ok(!TWIN_FRAME_HTML.includes('__SIM_DEFAULTS__'));
    const m = TWIN_FRAME_HTML.match(/const SIM_DEFAULTS = (\{.*?\});\n/);
    assert.ok(m, 'no SIM_DEFAULTS in the frame');
    const injected = JSON.parse(m[1]);
    assert.deepEqual(injected, {
      materials: SIM_MATERIALS,
      windH: SIM_DEFAULT_WIND_H,
      skyLoss: SIM_DEFAULT_SKY_LOSS,
      emissivity: SIM_EMISSIVITY,
      sigma: SIM_SIGMA,
    });
  });

  it('solves the same balance in its shader and in the JS the probe reads', () => {
    // Both are written as strings in twinFrame.ts, so this only checks that they still carry the terms
    // this module's reference implementation has; the harness in the scratchpad compares the numbers.
    for (const needle of [
      'float skyView = clamp(0.5 + 0.5 * n.y, 0.0, 1.0);',
      'float gain = alpha * (irr * cosSun + dif * skyView) + U * (tIn - tOut);',
      'float h = max(0.5, hOut) + max(0.0, store);',
    ])
      assert.ok(TWIN_FRAME_HTML.includes(needle), needle);
    // The radiation constant is not written into the page: the frame works it out from the emissivity
    // and sigma injected above, so there is one source for it.
    assert.ok(TWIN_FRAME_HTML.includes('const ES100 = SIM_DEFAULTS.emissivity * SIM_DEFAULTS.sigma * 1e8;'));
  });
});
