/*
 * The Adjust panel's effects — the pure half (shader sources and their
 * numbers; adjustCompose.ts stacks them, pictureAdjust.ts and adjustScene.ts
 * run them, pictureAdjustParams.ts says where the effects sit in the recipe
 * and keeps the list a picture has on).
 *
 * These are the Java app's jhlabs gallery filters, as the still's Process menu
 * ran them until 2026-11-20 (imageEditParams.ts had these sources; each was
 * read against the jhlabs Java line by line then, and the notes on why a
 * number is what it is are kept here). Three things changed in the move:
 *
 *  - An AMOUNT, 1…100 (user's call, 2026-11-20: effects as sliders). Where
 *    the filter has a number of its own, the amount sets that — Blur's radius,
 *    Posterize's levels, Threshold's cut, Edge's gain, Emboss's depth,
 *    Displace's and Glow's strength. Invert, Solarize, Sepia and Weave have
 *    none worth a slider and are mixed in: amount % of the effect over the
 *    picture. pictureAdjustParams.EFFECT_DEFAULT is the amount at which each
 *    is the menu's filter exactly; the functions below say what an amount is.
 *  - `reach`. The old menu ran every filter on a copy 0.9 × the screen wide,
 *    so "one pixel away" was one length on every picture. Here an effect runs
 *    on the picture at whatever size it is wanted — a thumbnail, the stage, a
 *    4:3 photograph's own pixels — so the neighbourhood effects step `reach`
 *    px (pictureAdjustParams.effectReach: the picture's width over 1080), and
 *    Blur's sigma and Weave's threads are that many times theirs.
 *  - Glow's blur. jhlabs' is a Gaussian of radius 2 (sigma 2/3), which the old
 *    engine made in a pass of its own; a sigma that small is nine taps, so
 *    here it is part of the one shader (GLOW_NEAR / GLOW_FAR are its weights).
 *
 * Every shader has one child, `s` — the picture in the canvas's pixel space,
 * read with LINEAR sampling (a `reach` that is not a whole pixel lands between
 * two) — and its uniforms in the order EFFECTS[…].uniforms hands them.
 * Colour is non-premultiplied 0..1; the picture's alpha is kept. Blur has no
 * shader: it is Skia's own Gaussian, at blurSigma(amount) × reach.
 *
 * Written with constructs the device's SkSL compiler has already taken in the
 * shaders these came from; __tests__/pictureEffectParams.test.ts hands every
 * source to Skia's compiler.
 */

import type {AdjustEffect} from './pictureAdjustParams';

/** An amount as a share: 0…1. */
export const mixOf = (amount: number): number => Math.min(1, Math.max(0, amount / 100));

// Shared by the four that are mixed in: the picture's colour as floats, and
// the way out.
const READ = `
  half4 c = s.eval(xy);
  float3 a = float3(float(c.r), float(c.g), float(c.b));`;
const WRITE = `
  float3 o = mix(a, b, amount);
  return half4(half(o.r), half(o.g), half(o.b), c.a);`;

/** Invert: 1 − c, mixed in. */
export const INVERT_SKSL = `
uniform shader s;
uniform float amount;
half4 main(float2 xy) {${READ}
  float3 b = float3(1.0, 1.0, 1.0) - a;${WRITE}
}
`;

// The classic sepia matrix (jhlabs). Each row sums past 1 (1.351 / 1.203 /
// 0.937), so the lights warm and clip: white comes out (255, 255, 239).
// prettier-ignore
export const SEPIA_ROWS = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
] as const;
/** Sepia: the matrix, clamped, mixed in. */
export const SEPIA_SKSL = `
uniform shader s;
uniform float amount;
half4 main(float2 xy) {${READ}
  float3 b = float3(
    ${SEPIA_ROWS[0][0]} * a.r + ${SEPIA_ROWS[0][1]} * a.g + ${SEPIA_ROWS[0][2]} * a.b,
    ${SEPIA_ROWS[1][0]} * a.r + ${SEPIA_ROWS[1][1]} * a.g + ${SEPIA_ROWS[1][2]} * a.b,
    ${SEPIA_ROWS[2][0]} * a.r + ${SEPIA_ROWS[2][1]} * a.g + ${SEPIA_ROWS[2][2]} * a.b);
  b = clamp(b, 0.0, 1.0);${WRITE}
}
`;

/** Solarize: per-channel jhlabs TransferFilter fold v → |2v−1|, mixed in. */
export const SOLARIZE_SKSL = `
uniform shader s;
uniform float amount;
half4 main(float2 xy) {${READ}
  float3 b = abs(2.0 * a - float3(1.0, 1.0, 1.0));${WRITE}
}
`;

/** jhlabs ThresholdFilter level (lowerThreshold == upperThreshold == 127), 0..255. */
export const THRESHOLD_LEVEL = 127;
/**
 * Threshold's cut for an amount: the brightness, 0..1, from which a pixel is
 * white. The amount is the cut in percent, set half a grey level low so float
 * rounding cannot flip a boundary: at 50 it is 380.5/765, the edge the menu's
 * filter used for jhlabs' 127 (of 255).
 */
export const thresholdCut = (amount: number): number => (7.65 * amount - 2) / 765;
/** Threshold: black or white on brightness (r+g+b)/3 ≥ cut. */
export const THRESHOLD_SKSL = `
uniform shader s;
uniform float cut;
half4 main(float2 xy) {
  half4 sc = s.eval(xy);
  float mean = (float(sc.r) + float(sc.g) + float(sc.b)) / 3.0;
  float v = step(cut, mean);
  return half4(half3(v), sc.a);
}
`;

/** Posterize's levels per channel as the menu had it (jhlabs PosterizeFilter default). */
export const POSTERIZE_LEVELS = 6;
/**
 * Posterize's levels for an amount: 31 at 1, down to 2 at 100, in even
 * ratios (each step of the slider takes the same share of the levels away);
 * 6 at 60.
 */
export const posterizeLevels = (amount: number): number =>
  Math.max(2, Math.round(2 * Math.pow(16, 1 - mixOf(amount))));
/**
 * Posterize: jhlabs maps an 8-bit channel i to 255·(L·i/256)/(L−1) with
 * INTEGER L·i/256 — a truncating bucketer; at L = 6, boundaries at
 * i ≈ 43/86/128/171/214 and the palette {0,51,102,153,204,255}. The channel is
 * rounded to its 8-bit index first so float error cannot slip a boundary.
 */
export const POSTERIZE_SKSL = `
uniform shader s;
uniform float levels;
float post(float c) {
  float i = floor(c * 255.0 + 0.5);
  float bucket = floor(levels * i / 256.0);
  return bucket / (levels - 1.0);
}
half4 main(float2 xy) {
  half4 c = s.eval(xy);
  return half4(half3(post(float(c.r)), post(float(c.g)), post(float(c.b))), c.a);
}
`;
/** POSTERIZE_SKSL's `post` over an 8-bit channel — the shader's oracle. */
export function posterizeByte(i: number, levels: number = POSTERIZE_LEVELS): number {
  const bucket = Math.floor((levels * i) / 256);
  return Math.round((bucket / (levels - 1)) * 255);
}

/** jhlabs EdgeFilter Sobel-magnitude divisor (sqrt(h²+v²)/1.8). */
export const EDGE_DIVISOR = 1.8;
/**
 * Edge's gain for an amount: in proportion, 8 at 50 (its default) and 16 at
 * 100. NOT the menu's filter at the default, which is gain 1 at 6: a thermal
 * picture's edges are soft, and at 1 its lines are all but black — so black
 * that its thumbnail in the panel read as an empty tile (found on a device,
 * 2026-11-20). 8 is where a thermal frame's outlines read plainly; 16 is
 * where a JPEG's block noise starts to show (tmp contact sheets, CanvasKit).
 */
export const EDGE_DEFAULT_GAIN = 8;
export const edgeGain = (amount: number): number => (EDGE_DEFAULT_GAIN * amount) / 50;
/** Edge: per-channel 3×3 Sobel magnitude over the neighbours `reach` px away, / 1.8, × gain. */
export const EDGE_SKSL = `
uniform shader s;
uniform float gain;
uniform float reach;
half4 main(float2 xy) {
  half4 sc = s.eval(xy);
  half3 tl = s.eval(xy + float2(-reach, -reach)).rgb;
  half3 tm = s.eval(xy + float2( 0.0,   -reach)).rgb;
  half3 tr = s.eval(xy + float2( reach, -reach)).rgb;
  half3 ml = s.eval(xy + float2(-reach,  0.0)).rgb;
  half3 mr = s.eval(xy + float2( reach,  0.0)).rgb;
  half3 bl = s.eval(xy + float2(-reach,  reach)).rgb;
  half3 bm = s.eval(xy + float2( 0.0,    reach)).rgb;
  half3 br = s.eval(xy + float2( reach,  reach)).rgb;
  half3 h = (bl + 2.0 * bm + br) - (tl + 2.0 * tm + tr);
  half3 v = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  half3 mag = sqrt(h * h + v * v) / ${EDGE_DIVISOR};
  float3 lines = float3(float(mag.r), float(mag.g), float(mag.b)) * gain;
  lines = clamp(lines, 0.0, 1.0);
  return half4(half(lines.r), half(lines.g), half(lines.b), sc.a);
}
`;

// jhlabs EmbossFilter's light (azimuth 135°, elevation 30°, pixelScale 255.9),
// (int)-truncated as the Java has them, and the surface normal's Z at the
// Java's default bump height of 1: Nz = 6·255 / (3 · bumpHeight).
export const EMBOSS_LX = -156;
export const EMBOSS_LY = 156;
export const EMBOSS_LZ = 127; // also a flat region's shade
export const EMBOSS_NZ = 510;
/**
 * Emboss's Nz for an amount — the bump height is (amount/50)², 1 at 50 (the
 * menu's filter) and 4 at 100; a taller bump is a smaller Nz, a deeper relief.
 */
export const embossNz = (amount: number): number =>
  EMBOSS_NZ / Math.max(0.0004, Math.pow(amount / 50, 2));
/**
 * Emboss (jhlabs EmbossFilter, emboss=false): a grey relief from the
 * brightness gradient, lit from (Lx, Ly, Lz). The bump window sits one row
 * down, as in the Java.
 */
export const EMBOSS_SKSL = `
uniform shader s;
uniform float Nz;
uniform float reach;
float lum(float2 p) {
  half3 c = s.eval(p).rgb;
  return (float(c.r) + float(c.g) + float(c.b)) * 85.0;
}
half4 main(float2 xy) {
  const float Lx = ${EMBOSS_LX}.0;
  const float Ly = ${EMBOSS_LY}.0;
  const float Lz = ${EMBOSS_LZ}.0;
  half4 sc = s.eval(xy);
  float tl = lum(xy + float2(-reach, 0.0));
  float tc = lum(xy + float2( 0.0,   0.0));
  float tr = lum(xy + float2( reach, 0.0));
  float ml = lum(xy + float2(-reach, reach));
  float mr = lum(xy + float2( reach, reach));
  float bl = lum(xy + float2(-reach, 2.0 * reach));
  float bc = lum(xy + float2( 0.0,   2.0 * reach));
  float br = lum(xy + float2( reach, 2.0 * reach));
  float Nx = (tl + ml + bl) - (tr + mr + br);
  float Ny = (bl + bc + br) - (tl + tc + tr);
  float shade;
  if (Nx == 0.0 && Ny == 0.0) {
    shade = Lz;
  } else {
    float NdotL = Nx * Lx + Ny * Ly + Nz * Lz;
    shade = NdotL < 0.0 ? 0.0 : NdotL / sqrt(Nx * Nx + Ny * Ny + Nz * Nz);
  }
  float g = clamp(shade / 255.0, 0.0, 1.0);
  return half4(half3(g), sc.a);
}
`;

/**
 * jhlabs DisplaceFilter's map scale at its amount of 1: the map value is
 * (r+g+b)/8 over 8-bit channels, 255/8 in 0..1. Float division — SkSL's
 * `255/8` is the integer 31.
 */
export const DISPLACE_SCALE = 255 / 8; // 31.875
/** Displace's scale for an amount: jhlabs' amount is amount/50 — 1 at 50 (the menu's filter). */
export const displaceScale = (amount: number): number => (DISPLACE_SCALE * amount) / 50;
/**
 * Displace (jhlabs DisplaceFilter, the picture its own map): each pixel is
 * read from where the 3×3 brightness gradient sends it — that many `reach`es
 * away.
 */
export const DISPLACE_SKSL = `
uniform shader s;
uniform float K;
uniform float reach;
float bri(half4 c) { return float(c.r) + float(c.g) + float(c.b); }
half4 main(float2 xy) {
  float tl = bri(s.eval(xy + float2(-reach, -reach)));
  float t  = bri(s.eval(xy + float2( 0.0,   -reach)));
  float tr = bri(s.eval(xy + float2( reach, -reach)));
  float l  = bri(s.eval(xy + float2(-reach,  0.0)));
  float r  = bri(s.eval(xy + float2( reach,  0.0)));
  float bl = bri(s.eval(xy + float2(-reach,  reach)));
  float b  = bri(s.eval(xy + float2( 0.0,    reach)));
  float br = bri(s.eval(xy + float2( reach,  reach)));
  float dx = K * ((tl + l + bl) - (tr + r + br));
  float dy = K * ((bl + b + br) - (tl + t + tr));
  half4 sc = s.eval(xy + float2(dx, dy) * reach);
  return half4(sc.rgb, sc.a);
}
`;

/** jhlabs GlowFilter defaults: Gaussian radius 2 (sigma = radius/3), amount 0.5. */
export const GLOW_SIGMA = 2 / 3;
/** Glow's blend at the menu's strength: result = clamp(src + a·blur), a = 4 · 0.5 (GlowFilter.java). */
export const GLOW_A = 2;
/** Glow's blend for an amount: all of the menu's at 100, and less below it (it burns a picture out fast). */
export const glowBlend = (amount: number): number => GLOW_A * mixOf(amount);
/** The nine-tap Gaussian's weights at one step (edge neighbours) and at √2 (corners); the centre's is 1. */
export const GLOW_NEAR = Math.exp(-1 / (2 * GLOW_SIGMA * GLOW_SIGMA));
export const GLOW_FAR = Math.exp(-2 / (2 * GLOW_SIGMA * GLOW_SIGMA));
/** Glow: the picture plus `glow` times a faint blur of itself. */
export const GLOW_SKSL = `
uniform shader s;
uniform float glow;
uniform float reach;
half4 main(float2 xy) {
  half4 sc = s.eval(xy);
  half3 sides = s.eval(xy + float2( reach, 0.0)).rgb + s.eval(xy + float2(-reach, 0.0)).rgb
              + s.eval(xy + float2( 0.0, reach)).rgb + s.eval(xy + float2( 0.0, -reach)).rgb;
  half3 corners = s.eval(xy + float2( reach,  reach)).rgb + s.eval(xy + float2(-reach,  reach)).rgb
                + s.eval(xy + float2( reach, -reach)).rgb + s.eval(xy + float2(-reach, -reach)).rgb;
  half3 soft = (sc.rgb + ${GLOW_NEAR.toFixed(5)} * sides + ${GLOW_FAR.toFixed(5)} * corners)
             / ${(1 + 4 * GLOW_NEAR + 4 * GLOW_FAR).toFixed(5)};
  float3 lit = float3(float(sc.r), float(sc.g), float(sc.b))
             + glow * float3(float(soft.r), float(soft.g), float(soft.b));
  lit = clamp(lit, 0.0, 1.0);
  return half4(half(lit.r), half(lit.g), half(lit.b), sc.a);
}
`;

/** jhlabs WeaveFilter thread width / gap, in `reach`es; the period is their sum, 22. */
export const WEAVE_THREAD_WIDTH = 16;
export const WEAVE_GAP = 6;
/**
 * Weave (jhlabs WeaveFilter): checkerboard warp and weft threads in the
 * picture's own colours, shaded where they cross under, the gaps black —
 * mixed in. (jhlabs leaves the gaps transparent; the old menu showed and
 * saved them over black — a JPEG has no alpha — and here what follows runs
 * over this shader's output and hands its alpha on, so a see-through pixel
 * given a colour would be no colour Skia knows. Black and opaque is what was
 * always seen.) The position is counted in whole `reach`es (jhlabs indexes by
 * integer pixel, so the fragment centre's half is dropped).
 */
export const WEAVE_SKSL = `
uniform shader s;
uniform float amount;
uniform float reach;
half4 main(float2 xy) {
  const float W = ${WEAVE_THREAD_WIDTH}.0;
  const float G = ${WEAVE_GAP}.0;
  const float P = W + G;
  const float H = W * 0.5;
  const float E = H + G;
  float x = floor(xy.x / reach) + W + G * 0.5;
  float y = floor(xy.y / reach) + W + G * 0.5;
  float nx = mod(x, P);
  float ny = mod(y, P);
  float ix = floor(x / P);
  float iy = floor(y / P);
  bool inX = nx < W;
  bool inY = ny < W;
  float m = mod(ix + iy, 2.0);${READ}
  // How much of the picture's colour a thread keeps here: none in a gap.
  float keep = 1.0;
  if (!inX && !inY) {
    keep = 0.0;
  } else if (inX && inY) {
    keep = 1.0;
  } else if (inX) {
    float cY = smoothstep(H, E, abs(H - ny));
    if (m < 0.5) { cY = 1.0 - cY; }
    keep = 1.0 - cY * 0.5;
  } else {
    float cX = smoothstep(H, E, abs(H - nx));
    if (m > 0.5) { cX = 1.0 - cX; }
    keep = 1.0 - cX * 0.5;
  }
  float3 b = a * keep;${WRITE}
}
`;

/** The menu's Blur: jhlabs GaussianFilter(10) — sigma = radius / 3 — in `reach`es. */
export const BLUR_SIGMA = 10 / 3;
/** Blur's sigma, in `reach`es, for an amount: a tenth of it — 10 at 100, the menu's 3.3 at 33. */
export const blurSigma = (amount: number): number => amount / 10;

/** How an effect is made. */
export interface EffectSpec {
  /** Its shader; null for Blur, which is Skia's own (blurSigma). */
  sksl: string | null;
  /**
   * It reads the picture around each pixel, so the picture must be an image
   * by then: stacked on another shader, every one of its samples would run
   * that shader again.
   */
  neighbours: boolean;
  /** The shader's uniforms, in the order it declares them, for an amount on a picture of this reach. */
  uniforms: (amount: number, reach: number) => number[];
}

export const EFFECTS: Record<AdjustEffect, EffectSpec> = {
  invert: {sksl: INVERT_SKSL, neighbours: false, uniforms: amount => [mixOf(amount)]},
  edge: {sksl: EDGE_SKSL, neighbours: true, uniforms: (amount, reach) => [edgeGain(amount), reach]},
  solarize: {sksl: SOLARIZE_SKSL, neighbours: false, uniforms: amount => [mixOf(amount)]},
  threshold: {sksl: THRESHOLD_SKSL, neighbours: false, uniforms: amount => [thresholdCut(amount)]},
  blur: {sksl: null, neighbours: true, uniforms: () => []},
  posterize: {
    sksl: POSTERIZE_SKSL,
    neighbours: false,
    uniforms: amount => [posterizeLevels(amount)],
  },
  sepia: {sksl: SEPIA_SKSL, neighbours: false, uniforms: amount => [mixOf(amount)]},
  emboss: {sksl: EMBOSS_SKSL, neighbours: true, uniforms: (amount, reach) => [embossNz(amount), reach]},
  displace: {
    sksl: DISPLACE_SKSL,
    neighbours: true,
    uniforms: (amount, reach) => [displaceScale(amount), reach],
  },
  glow: {sksl: GLOW_SKSL, neighbours: true, uniforms: (amount, reach) => [glowBlend(amount), reach]},
  // (Weave reads one pixel; the threads are placed by where it is.)
  weave: {sksl: WEAVE_SKSL, neighbours: false, uniforms: (amount, reach) => [mixOf(amount), reach]},
};
