/*
 * How the Adjust recipe is put together into one picture — the pure half of
 * running it. pictureAdjustParams.ts has the recipe and the sliders' shader,
 * pictureEffectParams.ts the effects'; this file decides which shader goes
 * over which, and where what is there so far must be drawn into pixels first.
 *
 * ONE COMPOSITION, TWO WAYS OF RUNNING IT. A picture is adjusted in two
 * places, and both come here:
 *
 *   for a file — a saved image, an export's frame, the panel's thumbnails,
 *     Auto's measuring copy — pictureAdjust.ts runs it on the JS thread and
 *     reads the pixels back;
 *   for the player's stage — adjustScene.ts records it, and the canvas runs it
 *     where it draws (nothing is drawn or copied back on the JS thread, which
 *     is what let an adjusted view play without stuttering).
 *
 * They differ in ONE thing, handed in as a ComposeKit: what "drawn once" is —
 * a raster pass read back as an image for the file, a tile (a picture of the
 * shader, made a shader: Skia draws it to a texture the first time it is asked
 * for) on the stage. Everything else — the order, the numbers, the `reach`,
 * where pixels are needed — is this file's, so the stage and a saved file
 * cannot part ways. (For a day they were composed in two places, and did:
 * Posterize under Edge came out different on the stage and in the file.)
 * __tests__/adjustCompose.test.ts runs both kits through Skia's own code
 * (CanvasKit) and holds them to the same bytes.
 *
 * WHY PIXELS AT ALL. Nesting shaders has a price: one that reads its child
 * several times runs the whole child each time. The sliders read the picture 5
 * times (Sharpness looks at four neighbours), an effect up to 9, one inside
 * the other 45 — nothing over a picture that is an image (one texture read),
 * far too much over one that is itself painted by a shader:
 *
 *   an image file                     1 read
 *   Infrared painted from the °C     17 (a bicubic over the grid, and the ramp)
 *   the synthesized Blended          43 (that, and 26 of the visible frame)
 *
 * So the plan: read what is under a stage directly while that stays within
 * DIRECT_READ_BUDGET texture reads a pixel, and otherwise draw it ONCE into
 * pixels, which everything after reads at one read a time. The sum is kept
 * along the whole chain — effects stack, in the order they were added, each
 * with an amount; each stage multiplies the reads of what is under it. Blur is
 * Skia's own filter and always pixels of its own.
 *
 * One such step is not about cost. AN EFFECT THAT READS AROUND ITS PIXEL
 * READS PIXELS: over another effect it is given that effect's output drawn
 * once, never the effect's shader. A neighbour `reach` px away is between two
 * pixels on any picture that is not 1080 wide, and "the effect under it,
 * worked out there" is not "its two pixels, mixed" unless that effect is a
 * straight line.
 *
 * On the stage pixels are not free: Skia keeps a tile in the canvas's texture
 * cache with no way for us to take it back, until its budget pushes it out.
 * That is why the common case — tone and colour sliders only, Sharpness at
 * zero — is kept off them: it runs the sliders' one-read cut
 * (ADJUST_TONE_SKSL) and needs no pixels over any base.
 *
 * KEPT PIXELS (the stage, a frame drawn again and again — the Adjust panel
 * open on it). What a step drew is kept by what it is a picture of: the
 * effects under it, in order, with their amounts ('' = the untouched base).
 * The next picture of the frame starts from the furthest one it can use, so a
 * slider move repaints the sliders alone and an effect's own slider what is
 * from that effect up. Two rules are for this only (`interactive`): the base
 * is drawn once whatever it costs, and once the same stack has come round
 * twice — it is the sliders that are moving — its whole output is, when
 * making it costs anything.
 */

import {
  ADJUST_KEYS,
  ADJUST_SKSL,
  ADJUST_TONE_SKSL,
  adjustUniforms,
  effectReach,
  type AdjustEffect,
  type PictureAdjust,
} from './pictureAdjustParams';
import {EFFECTS, blurSigma} from './pictureEffectParams';

/** What an un-adjusted picture is, as far as reading it goes. */
export type AdjustBaseKind = 'image' | 'thermal' | 'blend';

/** Texture reads one evaluation of the base costs (see the header). */
export const BASE_READS: Record<AdjustBaseKind, number> = {
  image: 1,
  thermal: 17,
  blend: 43,
};

/**
 * The most texture reads a pixel that are run directly. The synthesized
 * Blended view's 43, drawn twice a frame, is what has been watched playing
 * smoothly on a phone; a single pass of about that much again is taken on
 * trust, more is not.
 */
export const DIRECT_READ_BUDGET = 100;

/** How many times the sliders read their picture: Sharpness's four neighbours and the pixel. */
const SLIDER_READS = 5;
/** A neighbourhood effect's reads (the 3×3 ones; taken for any effect that reads around a pixel). */
const NEIGHBOUR_EFFECT_READS = 9;

/** One thing done, in order, to get from the base to the picture. */
export type ComposeStep =
  /**
   * Draw what is there so far once, into pixels. 'base': the untouched base.
   * 'stack': the picture with all its effects on (the panel is open and the
   * sliders are what is moving). 'part': a piece of the chain. `key`: what it
   * is a picture of — the effects under it (stackKeyOf's form).
   */
  | {do: 'tile'; what: 'base' | 'stack' | 'part'; key: string}
  /** Skia's Gaussian over what is there so far: pixels of its own. `key` as a tile's, Blur included. */
  | {do: 'blur'; amount: number; key: string}
  | {do: 'effect'; effect: Exclude<AdjustEffect, 'blur'>; amount: number}
  /** 'tone': the sliders' one-read cut. 'full': the five-read one. */
  | {do: 'sliders'; shader: 'tone' | 'full'};

export interface AdjustPlan {
  /** 'none': no slider is off zero. */
  sliders: 'none' | 'tone' | 'full';
  steps: ComposeStep[];
}

/** How many times `effect`'s shader reads its picture. */
export function effectReads(effect: AdjustEffect | null | undefined): number {
  if (effect == null || effect === 'blur') {
    return 1;
  }
  return EFFECTS[effect].neighbours ? NEIGHBOUR_EFFECT_READS : 1;
}

const stepKey = (s: {effect: AdjustEffect; amount: number}): string => `${s.effect}:${s.amount}`;

/** The effects of `a` and their amounts, in order, as one string ('' for none). */
export function stackKeyOf(a: PictureAdjust | null | undefined): string {
  return (a?.effects ?? []).map(stepKey).join('|');
}

/**
 * The plan for one picture.
 *
 * `interactive`: the same picture is being drawn again and again with other
 * settings. `stackSeen`: the one made just before had this very stack of
 * effects (both are the stage's, with the Adjust panel open — see the header).
 */
export function planAdjusted(
  base: AdjustBaseKind,
  a: PictureAdjust | null | undefined,
  opts: {interactive?: boolean; stackSeen?: boolean} = {},
): AdjustPlan {
  const anySlider = a != null && ADJUST_KEYS.some(k => a[k] !== 0);
  const sliders: AdjustPlan['sliders'] = !anySlider
    ? 'none'
    : (a as PictureAdjust).sharpness === 0
      ? 'tone'
      : 'full';
  // (One the panel holds at zero draws nothing.)
  const effects = (a?.effects ?? []).filter(s => s.amount > 0);
  const steps: ComposeStep[] = [];
  if (sliders === 'none' && effects.length === 0) {
    // A picture with nothing on it is drawn once, as it is.
    return {sliders, steps};
  }
  // What one read of the picture so far costs; the effects on it; whether it
  // is pixels as it stands.
  let reads = BASE_READS[base];
  const done: string[] = [];
  let pixels = false;
  const tile = (what?: 'stack'): void => {
    steps.push({do: 'tile', what: what ?? (done.length === 0 ? 'base' : 'part'), key: done.join('|')});
    reads = 1;
    pixels = true;
  };
  if (opts.interactive && base !== 'image') {
    tile();
  }
  // Whether making the stack's output costs anything worth keeping it for.
  let costly = false;
  for (const step of effects) {
    if (step.effect === 'blur') {
      // Blur draws what is under it once, whatever that costs.
      done.push(stepKey(step));
      steps.push({do: 'blur', amount: step.amount, key: done.join('|')});
      reads = 1;
      pixels = true;
      costly = true;
    } else {
      const r = effectReads(step.effect);
      // Over the budget — or it reads around its pixel and what is under it
      // is another effect's shader (see the header).
      if (reads * r > DIRECT_READ_BUDGET || (r > 1 && done.length > 0 && !pixels)) {
        tile();
      }
      done.push(stepKey(step));
      steps.push({do: 'effect', effect: step.effect, amount: step.amount});
      reads *= r;
      pixels = false;
      costly = costly || r > 1;
    }
  }
  if (opts.interactive && opts.stackSeen && costly) {
    tile('stack');
  }
  if (sliders !== 'none') {
    if (reads * (sliders === 'full' ? SLIDER_READS : 1) > DIRECT_READ_BUDGET) {
      tile();
    }
    steps.push({do: 'sliders', shader: sliders});
  }
  return {sliders, steps};
}

// ---------------------------------------------------------------- putting it together

/**
 * The three things composing needs done with shaders, by whoever runs the
 * result. `S` is that side's shader (Skia's on the device).
 */
export interface ComposeKit<S> {
  /** `sksl` — compiled once and kept — run over `child` with `uniforms`. */
  shade(sksl: string, uniforms: number[], child: S): S;
  /**
   * What `shader` draws, drawn once — under Skia's Gaussian of `blurSigma`
   * px where one is given — as a shader that reads those pixels, linear
   * between them and the same past the picture's edges as on them.
   */
  drawnOnce(shader: S, blurSigma?: number): S;
  /** Let go of something `shade` or `drawnOnce` made. */
  release(made: S): void;
}

/** What has been drawn once of one base, kept for its next picture (see the header). */
export interface KeptPixels<S> {
  /** By what each is a picture of: the effects on it, as a step's `key`. */
  byStack: Map<string, S>;
  /** The stack of the picture made last (stackKeyOf); null before the first. */
  lastStack: string | null;
}

export function newKeptPixels<S>(): KeptPixels<S> {
  return {byStack: new Map(), lastStack: null};
}

/** Let go of everything kept. */
export function releaseKeptPixels<S>(kept: KeptPixels<S>, kit: Pick<ComposeKit<S>, 'release'>): void {
  kept.byStack.forEach(made => kit.release(made));
  kept.byStack.clear();
  kept.lastStack = null;
}

/**
 * `base` with `a` on it, as one shader over the base's own pixel space: the
 * effects in the order they were added, then the sliders, each with the
 * `reach` of the picture's width.
 *
 * `temps` is what was made for this picture alone: the caller's to release
 * (kit.release) once it has drawn or recorded `shader`. With `kept`, what was
 * drawn once is kept there instead, reused by the next picture of the same
 * base, and let go of when a picture no longer has a use for it.
 *
 * Throws what the kit throws (a shader that will not compile, a surface that
 * cannot be made), having let go of what it made on the way.
 */
export function composeAdjusted<S>(
  base: {kind: AdjustBaseKind; shader: S; width: number},
  a: PictureAdjust | null | undefined,
  kit: ComposeKit<S>,
  opts: {interactive?: boolean; kept?: KeptPixels<S>} = {},
): {shader: S; temps: S[]} {
  const kept = opts.kept;
  const stack = stackKeyOf(a);
  const {steps} = planAdjusted(base.kind, a, {
    interactive: opts.interactive === true,
    // The same stack as the picture before: it is the sliders that moved.
    stackSeen: kept != null && kept.lastStack === stack,
  });
  if (kept != null) {
    kept.lastStack = stack;
  }
  const reach = effectReach(base.width);
  const temps: S[] = [];
  let cur = base.shader;
  // Whether `cur` is pixels already (drawing it once again gains nothing).
  let pixels = false;
  let from = 0;
  if (kept != null) {
    // Start from the furthest pixels kept: nothing under them is needed.
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      const hit =
        step.do === 'tile' || step.do === 'blur' ? kept.byStack.get(step.key) : undefined;
      if (hit !== undefined) {
        cur = hit;
        pixels = true;
        from = i + 1;
        break;
      }
    }
  }
  try {
    for (let i = from; i < steps.length; i++) {
      const step = steps[i];
      if (step.do === 'tile' || step.do === 'blur') {
        if (step.do === 'tile' && pixels) {
          continue;
        }
        const made = kit.drawnOnce(
          cur,
          step.do === 'blur' ? blurSigma(step.amount) * reach : undefined,
        );
        if (kept != null) {
          kept.byStack.set(step.key, made);
        } else {
          temps.push(made);
        }
        cur = made;
        pixels = true;
      } else {
        cur =
          step.do === 'effect'
            ? kit.shade(
                EFFECTS[step.effect].sksl as string,
                EFFECTS[step.effect].uniforms(step.amount, reach),
                cur,
              )
            : kit.shade(
                step.shader === 'tone' ? ADJUST_TONE_SKSL : ADJUST_SKSL,
                adjustUniforms(a as PictureAdjust, base.width),
                cur,
              );
        temps.push(cur);
        pixels = false;
      }
    }
  } catch (e) {
    temps.forEach(made => kit.release(made));
    throw e;
  }
  if (kept != null) {
    // What this picture's plan has no step for is of a stack that is gone.
    const wanted = new Set<string>();
    for (const step of steps) {
      if (step.do === 'tile' || step.do === 'blur') {
        wanted.add(step.key);
      }
    }
    for (const [key, made] of [...kept.byStack]) {
      if (!wanted.has(key)) {
        kept.byStack.delete(key);
        kit.release(made);
      }
    }
  }
  return {shader: cur, temps};
}
