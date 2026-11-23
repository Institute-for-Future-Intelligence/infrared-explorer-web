/*
 * The page scripts/check-picture-adjust.mjs opens in headless Chrome: the website's Process engine
 * (src/pictureAdjust/) run for real — through the site's built worker, over WebGL — and held to what it
 * must be. Posts each line to /log and the verdict to /result.
 *
 *  - the sliders against the app's own reference (core/pictureAdjustParams adjustPixels, the function the
 *    app's tests hold its shader to), on a picture that is not symmetric in any way — so a picture that
 *    came out flipped, or in another channel order, fails;
 *  - every effect the recipe has, alone at the amount it comes on at, and a stack of them: each must
 *    compile and run on WebGL (the phone runs the same source on another backend) and change the picture;
 *  - the page's own way of making a picture (no worker) against the worker's: the same bytes;
 *  - a picture too large for a texture; and settings that are no settings.
 *
 * Then how long a frame takes, for the record.
 */
import { adjustedFrameBlob } from '../src/pictureAdjust/adjustFrame';
import { makeAdjustedFrame } from '../src/pictureAdjust/adjustFrameJob';
import {
  ADJUST_EFFECTS,
  AdjustEffect,
  EFFECT_DEFAULT,
  NO_ADJUST,
  PictureAdjust,
  adjustPixels,
} from '../src/pictureAdjust/core/pictureAdjustParams';

const log = (line: string) => fetch('/log', { method: 'POST', body: line }).catch(() => undefined);

/** A test picture: gradients that differ along each axis and channel, and three shapes off its axes. */
function picture(w: number, h: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      image.data[o] = Math.round(40 + (170 * x) / w);
      image.data[o + 1] = Math.round(30 + (190 * y) / h);
      image.data[o + 2] = Math.round(60 + 120 * ((x / w) * (1 - y / h)));
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  ctx.fillStyle = '#f4f4f0';
  ctx.fillRect(w * 0.05, h * 0.04, w * 0.22, h * 0.1);
  ctx.fillStyle = '#102040';
  ctx.fillRect(w * 0.6, h * 0.7, w * 0.3, h * 0.2);
  ctx.fillStyle = '#d03020';
  ctx.beginPath();
  ctx.arc(w * 0.7, h * 0.25, w * 0.12, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

interface Pixels {
  w: number;
  h: number;
  data: Uint8Array;
}

async function pixelsOf(blob: Blob): Promise<Pixels> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  const data = new Uint8Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
  const out = { w: bitmap.width, h: bitmap.height, data };
  bitmap.close();
  return out;
}

/** How far two pictures are apart, in byte steps: on average, and at worst. */
function apart(a: Uint8Array, b: Uint8Array): { mean: number; max: number } {
  if (a.length !== b.length) return { mean: Infinity, max: Infinity };
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: Math.round((sum / a.length) * 100) / 100, max };
}

function upsideDown(p: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(p.length);
  for (let y = 0; y < h; y++) out.set(p.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}

const withEffects = (a: PictureAdjust, ...effects: [AdjustEffect, number][]): PictureAdjust => ({
  ...a,
  effects: effects.map(([effect, amount]) => ({ effect, amount })),
});

async function main() {
  const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
  const timings: Record<string, unknown> = {};
  let error: string | undefined;
  const check = (name: string, ok: boolean, detail?: unknown) => {
    checks.push({ name, ok, detail });
    void log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  };
  try {
    // The JPEG a made picture comes back as costs about half a byte step on average; a picture that is
    // wrong in any way that matters is tens of steps off.
    const CLOSE = 2;

    // ---- the sliders against the app's reference
    const W = 720;
    const H = 960;
    const png = await picture(W, H).convertToBlob({ type: 'image/png' });
    const source = await pixelsOf(png);
    const tone: PictureAdjust = {
      ...NO_ADJUST,
      brightness: 30,
      exposure: 10,
      contrast: 15,
      highlights: -30,
      shadows: 25,
      saturation: 20,
      vibrance: 10,
      warmth: 15,
      tint: -10,
      hue: 20,
    };
    const started = performance.now();
    const made = await adjustedFrameBlob(png, tone);
    timings.firstPictureMs = Math.round(performance.now() - started);
    const madePixels = await pixelsOf(made);
    check('a made picture keeps its size', madePixels.w === W && madePixels.h === H, { type: made.type });
    const reference = adjustPixels(source.data, W, H, tone, 1);
    const toReference = apart(madePixels.data, reference);
    const toUpsideDown = apart(madePixels.data, upsideDown(reference, W, H));
    check('the tone sliders are the app’s reference', toReference.mean < CLOSE, toReference);
    check('the picture is the right way up', toUpsideDown.mean > 10 * CLOSE, toUpsideDown);
    check('the sliders changed the picture', apart(madePixels.data, source.data).mean > 5);

    // ---- Sharpness, on a picture 1080 wide (where it reads its neighbours one whole pixel away)
    const W2 = 1080;
    const H2 = 1440;
    const png2 = await picture(W2, H2).convertToBlob({ type: 'image/png' });
    const source2 = await pixelsOf(png2);
    const sharp: PictureAdjust = { ...NO_ADJUST, sharpness: 60, contrast: 10 };
    const sharpened = await pixelsOf(await adjustedFrameBlob(png2, sharp));
    check(
      'Sharpness is the app’s reference',
      apart(sharpened.data, adjustPixels(source2.data, W2, H2, sharp, 1)).mean < CLOSE,
    );

    // ---- every effect, alone, and a stack of them under the sliders
    for (const effect of ADJUST_EFFECTS) {
      try {
        const blob = await adjustedFrameBlob(png, withEffects(NO_ADJUST, [effect, EFFECT_DEFAULT[effect]]));
        const p = await pixelsOf(blob);
        const changedBy = apart(p.data, source.data).mean;
        check(`effect ${effect} runs`, p.w === W && p.h === H && changedBy > 0.5, { changedBy });
      } catch (e) {
        check(`effect ${effect} runs`, false, e instanceof Error ? e.message : String(e));
      }
    }
    const stack = withEffects(tone, ['posterize', 60], ['edge', 50], ['blur', 20], ['emboss', 50], ['glow', 80]);
    const stacked = await adjustedFrameBlob(png, stack);
    const stackedPixels = await pixelsOf(stacked);
    check('five effects stack under the sliders', stackedPixels.w === W && stackedPixels.h === H);

    // ---- how long a frame takes: one after another, and thirty asked for at once. (Before the page
    // makes a picture itself, below: the longest block of the page here is what the workers cost it.)
    let longestBlock = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longestBlock = Math.max(longestBlock, entry.duration);
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // No long-task timing here.
    }
    const sizes: [string, number, number][] = [
      ['720 × 960', 720, 960],
      ['1080 × 1440', 1080, 1440],
    ];
    const cases: [string, PictureAdjust][] = [
      ['tone sliders', tone],
      ['Edge under Sharpness', withEffects({ ...tone, sharpness: 40 }, ['edge', 50])],
      ['five effects', stack],
    ];
    for (const [label, w, h] of sizes) {
      const jpeg = await picture(w, h).convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      for (const [name, adjust] of cases) {
        await adjustedFrameBlob(jpeg, adjust);
        const N = 30;
        let t = performance.now();
        for (let i = 0; i < N; i++) await adjustedFrameBlob(jpeg, adjust);
        const oneByOne = (performance.now() - t) / N;
        t = performance.now();
        await Promise.all(Array.from({ length: N }, () => adjustedFrameBlob(jpeg, adjust)));
        const atOnce = (performance.now() - t) / N;
        timings[`${label}, ${name}`] =
          `${oneByOne.toFixed(1)} ms a frame one by one, ${atOnce.toFixed(1)} asked for at once`;
      }
    }
    timings.longestBlockOfThePageMs = Math.round(longestBlock);

    // ---- the page's own way (no worker) against the worker's
    const here = await pixelsOf(await makeAdjustedFrame({ picture: png, adjust: stack }));
    check('the page makes the picture the worker makes', apart(here.data, stackedPixels.data).mean < 1);

    // ---- a picture too large for a texture comes out smaller, whole
    const large = await picture(5200, 3900).convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const fitted = await pixelsOf(await adjustedFrameBlob(large, tone));
    check('a 5200 × 3900 picture is made 4096 on its long side', fitted.w === 4096 && fitted.h === 3072, {
      w: fitted.w,
      h: fitted.h,
    });

    // ---- settings that are no settings: the picture itself
    check('nothing to adjust hands the picture back', (await adjustedFrameBlob(png, { ...NO_ADJUST })) === png);
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  }
  await fetch('/result', { method: 'POST', body: JSON.stringify({ checks, timings, error }) });
}

void main();
