/*
 * Picture adjustments — the pure half: the recipe (adjustCompose.ts puts its
 * shaders together; pictureAdjust.ts and adjustScene.ts run them with Skia).
 *
 * What a phone's photo editor calls Adjust, for a still and for a recording,
 * after the capture: eleven sliders, an Auto, and effects — any of a row of
 * them, each with its own slider, one on top of another. The same for every
 * view — Infrared, Visible and Blended go through
 * one recipe (user's call, 2026-11-19) — and never written into the file: the
 * settings are kept beside it (workspace.json `adjust`, one set per view),
 * applied whenever the picture is shown, and burnt in only where a copy
 * leaves as a new file. Taking them back to nothing is the original again, so
 * nothing here can be lost.
 *
 * The effects are what is left of the still's old Process menu (the Java
 * app's jhlabs filters), moved here on 2026-11-20 (user's calls): there they
 * were one-way — picked, chained, saved as a new photo, stills only — here
 * each is a setting like a slider's, previewed, taken back, and a recording's
 * too. As in that menu they stack, IN THE ORDER THEY WERE ADDED (Threshold
 * then Blur is not Blur then Threshold); new here, each has an amount —
 * where the filter had a number of its own (Blur's radius, Posterize's
 * levels, Threshold's cut) that is what the amount sets, and the rest are
 * mixed in by it. EFFECT_DEFAULT is the amount at which each looks as the
 * menu's filter did. The six of that menu the sliders already do went
 * (Brighten, Darken, the two Contrasts, Sharpen, Grayscale), and Quantize,
 * which only a whole-picture pass on the CPU can do. pictureEffectParams.ts
 * has each one's arithmetic.
 *
 * An adjusted Infrared or Blended picture no longer shows temperatures by its
 * colours, so the page takes its colour scale away while one is up
 * (`hidesScale`); sensors, isotherms and graphs read the temperature data,
 * not the pixels, and stay.
 *
 * The recipe, per pixel, on the picture's own 0..1 values, in this order:
 *
 *   effects     the ones added, in that order — FIRST, so the sliders act on
 *               the picture that is on screen (Brightness lightens an Edge
 *               picture's lines; it does not redraw them)
 *   sharpen     c += amount · (c − mean of the 4 neighbours `reach` px away)
 *   exposure    c × 2^(2e)              (a gain, ±2 stops: what Brightness is
 *                                        not — lights do burn out)
 *   brightness  c = c ^ gamma           (a tone curve, not a gain: a dim
 *                                        picture comes up without its lights
 *                                        burning out; gamma = 2^(−b))
 *   contrast    c = (c − 0.5) · k + 0.5 (about mid-grey)
 *   shadows,    c × (1 + Δ / luma), Δ = 1.2 · (s · l(1−l)² + h · l²(1−l)):
 *   highlights  each lifts or lowers its own end of the tones — Shadows'
 *               bump is greatest at a third, Highlights' at two thirds —
 *               and leaves black, white and the other end where they are;
 *               scaled with the luma, so a colour keeps its hue
 *   saturation  c = mix(luma, c, s)
 *   vibrance    the same, by v · (1 − the colour's own saturation): the
 *               dull colours move most, the vivid ones hardly
 *   hue         turned about the grey axis, ±180°
 *   warmth,     red × (1 + w), blue × (1 − w); green × (1 − t)
 *   tint        (± 0.25 each: cooler … warmer, green … magenta)
 *
 * Six of these — Exposure, Highlights, Shadows, Vibrance, Hue, Tint — came on
 * 2026-11-20 (user's call); a set stored before has none of them, which reads
 * as zero. Each is a few lines of the one shader: they cost a playing
 * recording nothing.
 *
 * `reach` is the picture's width over 1080, so Sharpness means the same on a
 * 720-wide painted frame and a 1080-wide photograph. `adjustPixels` below is
 * the same arithmetic over a byte buffer — the shader's test and its oracle.
 */

/** One set of slider positions. 0 everywhere = the picture as it is. */
export interface PictureAdjust {
  /** −100…100. */
  brightness: number;
  /** −100…100 (−2 … +2 stops). */
  exposure: number;
  /** −100…100. */
  contrast: number;
  /** −100…100 (the light end of the tones down … up). */
  highlights: number;
  /** −100…100 (the dark end of the tones down … up). */
  shadows: number;
  /** −100…100 (−100 = grey). */
  saturation: number;
  /** −100…100 (the dull colours greyer … livelier). */
  vibrance: number;
  /** −100…100 (cooler … warmer). */
  warmth: number;
  /** −100…100 (greener … more magenta). */
  tint: number;
  /** −100…100 (−180° … +180°; +60 turns red to yellow). */
  hue: number;
  /** 0…100. */
  sharpness: number;
  /**
   * The effects put on the picture before the sliders, in the order they are
   * applied — the order they were added. Each at most once. Absent = none.
   */
  effects?: readonly EffectStep[];
}

/** The effects, in the order the Java app's Process menu listed them (the panel's row). */
export const ADJUST_EFFECTS = [
  'invert',
  'edge',
  'solarize',
  'threshold',
  'blur',
  'posterize',
  'sepia',
  'emboss',
  'displace',
  'glow',
  'weave',
] as const;
export type AdjustEffect = (typeof ADJUST_EFFECTS)[number];

/**
 * One effect on the picture: which, and how much of it, 1…100. A step at 0
 * is one the Adjust panel is holding while its slider stands at zero (it
 * keeps its place, and the panel's frame stays on it — user's call,
 * 2026-11-20): it does nothing to the picture, nothing draws it, and it is
 * never stored (sanitizeAdjust drops it).
 */
export interface EffectStep {
  effect: AdjustEffect;
  amount: number;
}

/**
 * The amount an effect comes on at: where it looks as the Process menu's
 * filter did (pictureEffectParams.ts has what each amount means) — but for
 * Edge, whose menu filter was all but black on a thermal picture and comes on
 * eight times brighter. For the ones that are mixed in, that is all of it.
 */
export const EFFECT_DEFAULT: Record<AdjustEffect, number> = {
  invert: 100,
  edge: 50,
  solarize: 100,
  threshold: 50,
  blur: 33,
  posterize: 60,
  sepia: 100,
  emboss: 50,
  displace: 50,
  glow: 100,
  weave: 100,
};

const isEffect = (v: unknown): v is AdjustEffect =>
  typeof v === 'string' && (ADJUST_EFFECTS as readonly string[]).includes(v);

/** The sliders, in the order the panel names them (tone, then colour, then detail). */
export const ADJUST_KEYS = [
  'brightness',
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'saturation',
  'vibrance',
  'warmth',
  'tint',
  'hue',
  'sharpness',
] as const;
export type AdjustKey = (typeof ADJUST_KEYS)[number];

/** Each slider's travel (whole steps). */
export const ADJUST_RANGE: Record<AdjustKey, {min: number; max: number}> = {
  brightness: {min: -100, max: 100},
  exposure: {min: -100, max: 100},
  contrast: {min: -100, max: 100},
  highlights: {min: -100, max: 100},
  shadows: {min: -100, max: 100},
  saturation: {min: -100, max: 100},
  vibrance: {min: -100, max: 100},
  warmth: {min: -100, max: 100},
  tint: {min: -100, max: 100},
  hue: {min: -100, max: 100},
  sharpness: {min: 0, max: 100},
};

/** What each slider is called on screen (Title Case; English until i18n catches up). */
export const ADJUST_LABEL: Record<AdjustKey, string> = {
  brightness: 'Brightness',
  exposure: 'Exposure',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  saturation: 'Saturation',
  vibrance: 'Vibrance',
  warmth: 'Warmth',
  tint: 'Tint',
  hue: 'Hue',
  sharpness: 'Sharpness',
};

export const NO_ADJUST: PictureAdjust = {
  brightness: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  saturation: 0,
  vibrance: 0,
  warmth: 0,
  tint: 0,
  hue: 0,
  sharpness: 0,
};

/** True when any slider is off zero or an effect is on — the picture shown is not the file's. */
export function isAdjusted(a: PictureAdjust | null | undefined): boolean {
  return (
    a != null &&
    ((a.effects ?? []).some(s => s.amount > 0) || ADJUST_KEYS.some(k => a[k] !== 0))
  );
}

/** The same sliders, and the same effects at the same amounts in the same order. */
export function sameAdjust(a: PictureAdjust, b: PictureAdjust): boolean {
  const ea = a.effects ?? [];
  const eb = b.effects ?? [];
  return (
    ea.length === eb.length &&
    ea.every((s, i) => s.effect === eb[i].effect && s.amount === eb[i].amount) &&
    ADJUST_KEYS.every(k => a[k] === b[k])
  );
}

/** How much of `effect` is on `a`; 0 = it is off. */
export function effectAmount(a: PictureAdjust, effect: AdjustEffect): number {
  return a.effects?.find(s => s.effect === effect)?.amount ?? 0;
}

const slidersOf = (a: PictureAdjust): PictureAdjust => {
  const out = {...NO_ADJUST};
  for (const k of ADJUST_KEYS) {
    out[k] = a[k];
  }
  return out;
};

/** `a` with `effects` on it; with none the key is left out, as a stored set has it. */
export function withEffects(
  a: PictureAdjust,
  effects: readonly EffectStep[] | null | undefined,
): PictureAdjust {
  const sliders = slidersOf(a);
  return effects != null && effects.length > 0 ? {...sliders, effects} : sliders;
}

/**
 * `a` with `effect` at `amount`. One that is in the stack keeps its place in
 * the order; one that was not is added LAST (it goes on top of what is
 * there). An amount of 0 takes it out, and the ones after it move up — or,
 * with `holdAtZero` (the panel's slider), leaves it where it is at 0.
 */
export function withEffectAmount(
  a: PictureAdjust,
  effect: AdjustEffect,
  amount: number,
  holdAtZero: boolean = false,
): PictureAdjust {
  const to = Math.min(100, Math.max(0, Math.round(amount)));
  const was = a.effects ?? [];
  const on = was.some(s => s.effect === effect);
  const next =
    to === 0 && !(holdAtZero && on)
      ? was.filter(s => s.effect !== effect)
      : on
        ? was.map(s => (s.effect === effect ? {effect, amount: to} : s))
        : [...was, {effect, amount: to}];
  return withEffects(a, next);
}

/** `a` without the effects held at zero (see EffectStep). */
export function withoutHeldEffects(a: PictureAdjust): PictureAdjust {
  return withEffects(
    a,
    (a.effects ?? []).filter(s => s.amount > 0),
  );
}

const clampStep = (v: unknown, key: AdjustKey): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  const {min, max} = ADJUST_RANGE[key];
  return Math.min(max, Math.max(min, n));
};

/**
 * A stored set as the app trusts it: every slider a whole step inside its
 * travel; the effects ones this build knows (any other is dropped), each
 * once, at a whole amount 1…100, in the order stored. Null for anything that
 * is not a set, and for one with every slider at zero and no effect (which is
 * "no adjustment", and is stored as nothing).
 *
 * (`effect: 'edge'` — one name, no amount — is how the first build of the
 * effects stored its single one, for a day in 2026-11: read as that effect at
 * its default.)
 */
export function sanitizeAdjust(raw: unknown): PictureAdjust | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Partial<Record<AdjustKey | 'effect' | 'effects', unknown>>;
  // (A slider the stored set does not have — one added since — is zero.)
  const out: PictureAdjust = {...NO_ADJUST};
  for (const k of ADJUST_KEYS) {
    out[k] = clampStep(r[k], k);
  }
  const steps: EffectStep[] = [];
  if (Array.isArray(r.effects)) {
    for (const item of r.effects as unknown[]) {
      const step = item as {effect?: unknown; amount?: unknown} | null;
      const amount =
        step != null && typeof step.amount === 'number' && Number.isFinite(step.amount)
          ? Math.min(100, Math.round(step.amount))
          : 0;
      if (
        step != null &&
        isEffect(step.effect) &&
        amount >= 1 &&
        !steps.some(s => s.effect === step.effect)
      ) {
        steps.push({effect: step.effect, amount});
      }
    }
  } else if (isEffect(r.effect)) {
    steps.push({effect: r.effect, amount: EFFECT_DEFAULT[r.effect]});
  }
  if (steps.length > 0) {
    out.effects = steps;
  }
  return isAdjusted(out) ? out : null;
}

/**
 * The views a file's pictures come in — one set of sliders each. 'captured'
 * is a still's own saved picture (the photo page's Captured view: the frame as
 * it was shot, overlays and all); a recording has the first three.
 */
export type AdjustView = 'ir' | 'visible' | 'blended' | 'captured';
const ADJUST_VIEWS: readonly AdjustView[] = ['ir', 'visible', 'blended', 'captured'];

/** A file's adjustments: the views that have one, and nothing for the rest. */
export type ViewAdjusts = Partial<Record<AdjustView, PictureAdjust>>;

/** workspace.json `adjust` as the app trusts it; undefined when no view is adjusted. */
export function sanitizeViewAdjusts(raw: unknown): ViewAdjusts | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Partial<Record<AdjustView, unknown>>;
  const out: ViewAdjusts = {};
  for (const view of ADJUST_VIEWS) {
    const a = sanitizeAdjust(r[view]);
    if (a != null) {
      out[view] = a;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `all` with `view` set to `next` (dropped when `next` is no adjustment);
 * undefined when that leaves no view adjusted — the key then stays out of the
 * file.
 */
export function withViewAdjust(
  all: ViewAdjusts | undefined,
  view: AdjustView,
  next: PictureAdjust | null,
): ViewAdjusts | undefined {
  const out: ViewAdjusts = {...(all ?? {})};
  const clean = sanitizeAdjust(next);
  if (clean != null) {
    out[view] = clean;
  } else {
    delete out[view];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The view a processed file's thumbnail shows (files.ts ADJUSTED_THUMB_FILE):
 * the one just processed (`prefer` — the Process panel's Done landed on it)
 * while it has adjustments, else the first of `views` that has any; null when
 * none has, and the file is shown by its own picture again. So taking one
 * view's adjustments off leaves the thumbnail on another's, not on the file as
 * captured while it still opens to a processed view.
 */
export function adjustedThumbView<V extends AdjustView>(
  all: ViewAdjusts | undefined,
  prefer: V | null,
  views: readonly V[],
): V | null {
  if (prefer != null && isAdjusted(all?.[prefer])) {
    return prefer;
  }
  return views.find(v => isAdjusted(all?.[v])) ?? null;
}

/**
 * Whether a view's colour scale must stand down: its picture is adjusted and
 * its colours used to mean temperatures (Infrared, Blended). A Visible picture
 * never had a scale.
 */
export function hidesScale(view: string, a: PictureAdjust | null | undefined): boolean {
  return view !== 'visible' && isAdjusted(a);
}

// ---------------------------------------------------------------- the recipe

/** The numbers the recipe runs on, out of the slider positions. */
export interface AdjustFactors {
  /** Exponent of the tone curve: 0.5 (brightest) … 2. */
  gamma: number;
  /** Slope about mid-grey: 0.2 … 2. */
  contrast: number;
  /** 0 (grey) … 2. */
  saturation: number;
  /** ±0.25: red × (1 + warm), blue × (1 − warm). */
  warm: number;
  /** 0 … 1.5: how much of the local difference is added back. */
  sharpen: number;
  /** Exposure's gain: 0.25 … 4. */
  gain: number;
  /** ±SHADOW_SPAN: the dark end's bump (see the header). */
  shadows: number;
  /** ±SHADOW_SPAN: the light end's. */
  highlights: number;
  /** ±0.25: green × (1 − tint). */
  tint: number;
  /** −1 … 1. */
  vibrance: number;
  /** The hue turn's cosine, and its sine over √3 (what the shader multiplies by). */
  hueCos: number;
  hueSin: number;
}

/** Highlights' and Shadows' strength at ±100 — what their bump is multiplied by. */
const SHADOW_SPAN = 1.2;

export function adjustFactors(a: PictureAdjust): AdjustFactors {
  const turn = (Math.PI * a.hue) / 100;
  return {
    gamma: Math.pow(2, -a.brightness / 100),
    contrast: a.contrast >= 0 ? 1 + a.contrast / 100 : 1 + (0.8 * a.contrast) / 100,
    saturation: 1 + a.saturation / 100,
    warm: (0.25 * a.warmth) / 100,
    sharpen: (1.5 * a.sharpness) / 100,
    gain: Math.pow(2, (2 * a.exposure) / 100),
    shadows: (SHADOW_SPAN * a.shadows) / 100,
    highlights: (SHADOW_SPAN * a.highlights) / 100,
    tint: (0.25 * a.tint) / 100,
    vibrance: a.vibrance / 100,
    hueCos: Math.cos(turn),
    hueSin: Math.sin(turn) / Math.sqrt(3),
  };
}

/** Sharpen's sample distance for a picture `width` px wide (see the header). At least 1. */
export function adjustReach(width: number): number {
  return Math.max(1, width / 1080);
}

/**
 * An effect's unit of length for a picture `width` px wide: its kernels were
 * written in the pixels of a 1080-wide picture, and reach that fraction of any
 * other — so Edge draws the same lines on a 480-wide photograph, on its
 * 1080-wide export and on the panel's thumbnail. Not held at 1 as Sharpen's
 * is: the effects read the picture with linear sampling, and a step of a
 * fraction of a pixel is a difference in proportion.
 */
export function effectReach(width: number): number {
  return Math.max(0.05, width / 1080);
}

/** Rec. 601 luma weights, as the shader uses them (msxSynthParams' too). */
const LUMA = [0.299, 0.587, 0.114] as const;

/** Highlights / Shadows divide by the luma down to this (a near-black pixel is not multiplied without end). */
const TONE_FLOOR = 0.05;

// Sharpness's part of the sliders' shader: the read of a neighbour, and the
// two statements that read the four of them and add the difference back. They
// are the only part that looks beyond the pixel itself — see slidersSksl.
const SHARPEN_PICK = `
float3 pick(float2 p) {
  half4 s = img.eval(p);
  return float3(float(s.r), float(s.g), float(s.b));
}
`;
const SHARPEN_STEP = `
  float3 around = pick(xy + float2(reach, 0.0)) + pick(xy - float2(reach, 0.0))
                + pick(xy + float2(0.0, reach)) + pick(xy - float2(0.0, reach));
  c = c + sharpen * (c - around * 0.25);`;

/**
 * The sliders' shader source. One child, `img` — the picture (with its
 * effects on, where it has any), in the canvas's own pixel space. Uniforms, in
 * declared order: gamma, contrast, saturation, warm, sharpen, reach, gain,
 * shadows, highlights, tint, vibrance, hueCos, hueSin (adjustUniforms).
 *
 * It comes in two cuts of one source. With Sharpness in it the shader reads
 * its picture five times a pixel; without, once — and with Sharpness at zero
 * the two give the same picture (the statement left out adds 0). The one-read
 * cut is what a picture with only tone and colour sliders on is run with
 * where the picture under it is costly to read (adjustCompose.ts). Both
 * declare the same uniforms, so adjustUniforms feeds either.
 *
 * Written with nothing but constructs the device's SkSL compiler has already
 * taken in the two shaders beside it (msxSynthParams.ts, thermalRenderParams.ts):
 * scalar casts, float vectors built from scalars, clamp / dot / mix / pow /
 * max / min, no branches. Every slider at zero is every step multiplying by 1
 * or adding 0 (the identity test holds it to the byte).
 */
const slidersSksl = (withSharpness: boolean): string => `
uniform shader img;
uniform float gamma;
uniform float contrast;
uniform float saturation;
uniform float warm;
uniform float sharpen;
uniform float reach;
uniform float gain;
uniform float shadows;
uniform float highlights;
uniform float tint;
uniform float vibrance;
uniform float hueCos;
uniform float hueSin;
${withSharpness ? SHARPEN_PICK : ''}
half4 main(float2 xy) {
  half4 src = img.eval(xy);
  float3 c = float3(float(src.r), float(src.g), float(src.b));${withSharpness ? SHARPEN_STEP : ''}
  c = clamp(c, 0.0, 1.0);
  c = clamp(c * gain, 0.0, 1.0);
  c = pow(c, float3(gamma, gamma, gamma));
  c = (c - float3(0.5, 0.5, 0.5)) * contrast + float3(0.5, 0.5, 0.5);
  float3 W = float3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]});
  float t = clamp(dot(c, W), 0.0, 1.0);
  float lift = shadows * t * (1.0 - t) * (1.0 - t) + highlights * t * t * (1.0 - t);
  c = c * (1.0 + lift / max(t, ${TONE_FLOOR}));
  float l = dot(c, W);
  c = mix(float3(l, l, l), c, saturation);
  float sat = clamp(max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b), 0.0, 1.0);
  l = dot(c, W);
  c = mix(float3(l, l, l), c, 1.0 + vibrance * (1.0 - sat));
  float mean = (c.r + c.g + c.b) / 3.0;
  c = c * hueCos + float3(c.b - c.g, c.r - c.b, c.g - c.r) * hueSin
    + float3(mean, mean, mean) * (1.0 - hueCos);
  c = c * float3(1.0 + warm, 1.0 - tint, 1.0 - warm);
  c = clamp(c, 0.0, 1.0);
  return half4(half(c.r), half(c.g), half(c.b), src.a);
}
`;

/** The sliders' shader, all of it: five reads of the picture a pixel. */
export const ADJUST_SKSL = slidersSksl(true);
/** The same without Sharpness's part: one read. The same picture while Sharpness is zero. */
export const ADJUST_TONE_SKSL = slidersSksl(false);

/** The shaders' uniforms for `a`, drawn `width` px wide. */
export function adjustUniforms(a: PictureAdjust, width: number): number[] {
  const f = adjustFactors(a);
  return [
    f.gamma,
    f.contrast,
    f.saturation,
    f.warm,
    f.sharpen,
    adjustReach(width),
    f.gain,
    f.shadows,
    f.highlights,
    f.tint,
    f.vibrance,
    f.hueCos,
    f.hueSin,
  ];
}

/**
 * Reference implementation over an RGBA byte buffer (row-major, w×h): the
 * sliders' part of the recipe as the shader runs it (no effects), with a whole-pixel `reach` (the shader samples
 * between pixels on a picture not 1080 wide; the tests use reach 1). Returns a
 * new buffer; alpha is kept. Not used on the device.
 */
export function adjustPixels(
  rgba: Uint8Array,
  w: number,
  h: number,
  a: PictureAdjust,
  reach: number = 1,
): Uint8Array {
  if (rgba.length !== w * h * 4) {
    throw new Error('adjustPixels: buffer must be w*h*4 bytes');
  }
  const f = adjustFactors(a);
  const step = Math.max(1, Math.round(reach));
  const at = (x: number, y: number, ch: number): number =>
    rgba[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + ch] / 255;
  const out = new Uint8Array(rgba.length);
  const c = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < 3; ch++) {
        const own = at(x, y, ch);
        const around =
          at(x + step, y, ch) + at(x - step, y, ch) + at(x, y + step, ch) + at(x, y - step, ch);
        let v = own + f.sharpen * (own - around * 0.25);
        v = Math.min(1, Math.max(0, v));
        v = Math.min(1, Math.max(0, v * f.gain));
        v = Math.pow(v, f.gamma);
        c[ch] = (v - 0.5) * f.contrast + 0.5;
      }
      const luma = (): number => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
      const t = Math.min(1, Math.max(0, luma()));
      const lift = f.shadows * t * (1 - t) * (1 - t) + f.highlights * t * t * (1 - t);
      const k = 1 + lift / Math.max(t, TONE_FLOOR);
      for (let ch = 0; ch < 3; ch++) {
        c[ch] *= k;
      }
      let l = luma();
      for (let ch = 0; ch < 3; ch++) {
        c[ch] = l + (c[ch] - l) * f.saturation;
      }
      const sat = Math.min(
        1,
        Math.max(0, Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])),
      );
      l = luma();
      const vib = 1 + f.vibrance * (1 - sat);
      for (let ch = 0; ch < 3; ch++) {
        c[ch] = l + (c[ch] - l) * vib;
      }
      const mean = (c[0] + c[1] + c[2]) / 3;
      const [r, g, b] = c;
      const turned = [
        r * f.hueCos + (b - g) * f.hueSin + mean * (1 - f.hueCos),
        g * f.hueCos + (r - b) * f.hueSin + mean * (1 - f.hueCos),
        b * f.hueCos + (g - r) * f.hueSin + mean * (1 - f.hueCos),
      ];
      const o = (y * w + x) * 4;
      const tone = [1 + f.warm, 1 - f.tint, 1 - f.warm];
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] = Math.round(Math.min(1, Math.max(0, turned[ch] * tone[ch])) * 255);
      }
      out[o + 3] = rgba[o + 3];
    }
  }
  return out;
}

// ---------------------------------------------------------------- Auto

/** Where Auto wants the middle of the picture's tones, and how wide it wants them. */
const AUTO_MEDIAN_LOW = 0.4;
const AUTO_MEDIAN_HIGH = 0.58;
const AUTO_MEDIAN_TARGET = 0.46;
const AUTO_SPREAD_TARGET = 0.72;
/** The most Auto will move a slider: it suggests, the user finishes. */
const AUTO_BRIGHTNESS_MAX = 80;
const AUTO_CONTRAST_MAX = 40;

/** The tone (0..1) below which `fraction` of the histogram's pixels fall. */
function percentile(hist: ArrayLike<number>, total: number, fraction: number): number {
  const want = total * fraction;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= want) {
      return (i + 0.5) / hist.length;
    }
  }
  return 1;
}

/**
 * Auto: Brightness and Contrast for a picture, from its luminance histogram
 * (any number of equal bins over 0..1; pictureAdjust.lumaHistogram makes 64).
 *
 *   Brightness — the tone curve that brings the median to AUTO_MEDIAN_TARGET,
 *     when the median sits outside [AUTO_MEDIAN_LOW, AUTO_MEDIAN_HIGH] (a
 *     picture already in the middle is left alone). This is the dim indoor
 *     visible frame's fix.
 *   Contrast — after that curve, widen the 2 %–98 % span toward
 *     AUTO_SPREAD_TARGET, but never so far that either end is pushed past
 *     black or white.
 *
 * Saturation, Warmth and Sharpness are a matter of taste and stay at zero. An
 * empty histogram gives no adjustment.
 */
export function autoAdjust(hist: ArrayLike<number>): PictureAdjust {
  let total = 0;
  for (let i = 0; i < hist.length; i++) {
    total += hist[i];
  }
  if (!(total > 0) || hist.length < 2) {
    return {...NO_ADJUST};
  }
  const median = percentile(hist, total, 0.5);
  let gamma = 1;
  if (median < AUTO_MEDIAN_LOW || median > AUTO_MEDIAN_HIGH) {
    const m = Math.min(0.98, Math.max(0.02, median));
    gamma = Math.log(AUTO_MEDIAN_TARGET) / Math.log(m);
  }
  // (`|| 0`: a curve of exactly 1 rounds to −0, which is not the 0 a stored
  // "no adjustment" compares equal to.)
  const brightness =
    Math.min(
      AUTO_BRIGHTNESS_MAX,
      Math.max(-AUTO_BRIGHTNESS_MAX, Math.round(-Math.log2(gamma) * 100)),
    ) || 0;
  // The curve Auto will really apply (after the cap), for the span it leaves.
  const applied = Math.pow(2, -brightness / 100);
  const lo = Math.pow(percentile(hist, total, 0.02), applied);
  const hi = Math.pow(percentile(hist, total, 0.98), applied);
  const spread = hi - lo;
  let contrast = 0;
  if (spread > 0.02 && spread < AUTO_SPREAD_TARGET) {
    let k = AUTO_SPREAD_TARGET / spread;
    // Neither end past black or white.
    if (hi > 0.5) {
      k = Math.min(k, 0.5 / (hi - 0.5));
    }
    if (lo < 0.5) {
      k = Math.min(k, 0.5 / (0.5 - lo));
    }
    contrast = Math.min(AUTO_CONTRAST_MAX, Math.max(0, Math.round((k - 1) * 100)));
  }
  return {...NO_ADJUST, brightness, contrast};
}
