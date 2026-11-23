/**
 * One picture with a set of Process settings on it, start to finish — the work a worker is handed
 * (pictureAdjust/adjustFrame.ts hands it; this file is what runs there, and on the page where there is no
 * worker that can). Nothing in it touches the DOM beyond a canvas, or Firebase: the picture arrives as a
 * blob and leaves as one.
 *
 * THE SAME RECIPE AS THE PHONE'S, BY THE SAME SOURCE. What the settings do to a picture is the capture
 * app's (its Adjust panel, shown as Process): eleven sliders and a stack of effects, written as Skia
 * shaders. core/ holds the app's own files — the numbers and the shaders (pictureAdjustParams,
 * pictureEffectParams) and the order they go one over the other, with where what is there so far must be
 * drawn into pixels first (adjustCompose) — copied, never edited here (npm run sync:lab-core). This file is
 * the app's pictureAdjust.ts (shadeWith, drawOnce, rasterKit, adjustShader) written against CanvasKit,
 * which is Skia compiled for the browser: the app's own tests hold the recipe to it.
 *
 * ON THE GPU, OR NOT AT ALL (measured 2026-11-21, headless Chrome, a 720 × 960 frame). CanvasKit's CPU
 * surface took 0.7 s for the tone sliders alone, 5 s with Edge under them, 14 s with Blur and Emboss —
 * nothing a player can wait for. Over WebGL the same pictures took 2 ms to draw and about 20 ms a frame
 * all told (decoding 4, the JPEG 13); a 1080 × 1440 one about 35 ms; and Chrome's software GL, for a
 * machine without a graphics card, 20 to 100 ms. So there is no CPU path: where no WebGL context can be
 * had the job fails, and the caller shows the picture as it is stored.
 *
 * One WebGL context a worker (or the page), made on a canvas nobody sees; every picture is drawn into a
 * render target of its own size on it and read back, so pictures of different sizes — a recording's
 * infrared and visible frames — share the context and its compiled shaders.
 */
import CanvasKitInit from 'canvaskit-wasm';
import type { Canvas, CanvasKit, GrDirectContext, Image, RuntimeEffect, Shader, Surface } from 'canvaskit-wasm';
import wasmUrl from 'canvaskit-wasm/bin/canvaskit.wasm?url';
import { Decoded, decode, encode, release, sizeOf } from '../utils/msxSynth';
import { ComposeKit, composeAdjusted } from './core/adjustCompose';
import { PictureAdjust, isAdjusted } from './core/pictureAdjustParams';

export interface AdjustFrameJob {
  /** The picture as it is stored or was made: anything the browser decodes. */
  picture: Blob;
  adjust: PictureAdjust;
}

/**
 * The longest side a picture is processed at. A recording's frames are far under it; a photo brought in
 * from a phone's own camera can be over what a WebGL texture holds, and is made this size first.
 */
const MAX_SIDE = 4096;

interface Engine {
  ck: CanvasKit;
  gr: GrDirectContext;
  /** The recipe's shaders, compiled once each, by their source (the sliders' two cuts and the effects'). */
  compiled: Map<string, RuntimeEffect>;
  /** The longest side a texture may have here. */
  maxSide: number;
}

type GlCanvas = OffscreenCanvas | HTMLCanvasElement;

/**
 * A canvas nobody sees. On the page an element, not an OffscreenCanvas: some browsers (Safari before 17)
 * have the offscreen kind for 2D only, and there the page is where this runs.
 */
function glCanvas(): GlCanvas {
  if (typeof document !== 'undefined') return document.createElement('canvas');
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
  throw new Error('No canvas to draw on.');
}

// Started by the first job; a context the browser takes back (the GPU process restarting, too many
// contexts) drops it, and the next job starts another.
let engine: Promise<Engine> | null = null;

async function startEngine(): Promise<Engine> {
  const ck = await CanvasKitInit({ locateFile: () => wasmUrl });
  const canvas = glCanvas();
  const handle = ck.GetWebGLContext(canvas, { antialias: 0, depth: 0, stencil: 0, alpha: 1 });
  const gr = handle ? ck.MakeWebGLContext(handle) : null;
  if (!gr) throw new Error('WebGL is not available.');
  canvas.addEventListener('webglcontextlost', () => {
    engine = null;
  });
  // (Asking a canvas for the kind of context it has hands back the one CanvasKit made.)
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
  const limit = gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : 0;
  return { ck, gr, compiled: new Map(), maxSide: limit > 0 ? Math.min(MAX_SIDE, limit) : 2048 };
}

function engineOf(): Promise<Engine> {
  if (!engine) {
    const starting = startEngine();
    engine = starting;
    // One that did not start is not kept: the next job finds out again (a context may be had later).
    starting.catch(() => {
      if (engine === starting) engine = null;
    });
  }
  return engine;
}

/** The app's shadeWith: `sksl` run over `child` with `uniforms`. Throws where the source will not compile. */
function shadeWith(e: Engine, sksl: string, uniforms: number[], child: Shader): Shader {
  let effect = e.compiled.get(sksl);
  if (!effect) {
    let why = '';
    const made = e.ck.RuntimeEffect.Make(sksl, (m) => {
      why = m;
    });
    if (!made) throw new Error(`A Process shader failed to compile. ${why}`.trim());
    effect = made;
    e.compiled.set(sksl, effect);
  }
  return effect.makeShaderWithChildren(uniforms, [child]);
}

/**
 * `img` as a shader over its own pixels — linear (the sharpen and the effects sample between pixels on a
 * picture that is not 1080 wide) and clamped (it reads the same past its edges as on them). The app's
 * linearShader.
 */
const linearShader = (ck: CanvasKit, img: Image): Shader =>
  img.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None);

/**
 * What `shader` draws over w×h, drawn on `canvas` — under Skia's Gaussian of `blurSigma` px where one is
 * given (the Blur effect). The app's drawOnce, to the line: the blur reads past the picture's edge, so what
 * is under it is drawn that much wider and the result clipped back.
 */
function drawOnce(ck: CanvasKit, canvas: Canvas, shader: Shader, w: number, h: number, blurSigma?: number): void {
  const rect = ck.XYWHRect(0, 0, w, h);
  const paint = new ck.Paint();
  paint.setStyle(ck.PaintStyle.Fill);
  paint.setShader(shader);
  if (blurSigma == null || !(blurSigma > 0)) {
    canvas.drawRect(rect, paint);
    paint.delete();
    return;
  }
  const pad = Math.ceil(blurSigma * 4) + 2;
  const blur = ck.ImageFilter.MakeBlur(blurSigma, blurSigma, ck.TileMode.Decal, null);
  paint.setImageFilter(blur);
  canvas.save();
  canvas.clipRect(rect, ck.ClipOp.Intersect, false);
  canvas.drawRect(ck.XYWHRect(-pad, -pad, w + 2 * pad, h + 2 * pad), paint);
  canvas.restore();
  blur.delete();
  paint.delete();
}

function renderTarget(e: Engine, w: number, h: number): Surface {
  const surface = e.ck.MakeRenderTarget(e.gr, w, h);
  if (!surface) throw new Error('The picture could not be drawn.');
  return surface;
}

/** adjustCompose's kit here: "drawn once" is a render target, read as a texture by what comes after. */
function glKit(e: Engine, w: number, h: number): ComposeKit<Shader> {
  // What is under each shader a pass was drawn into.
  const passes = new Map<Shader, { image: Image; surface: Surface }>();
  return {
    shade: (sksl, uniforms, child) => shadeWith(e, sksl, uniforms, child),
    drawnOnce: (shader, blurSigma) => {
      const surface = renderTarget(e, w, h);
      drawOnce(e.ck, surface.getCanvas(), shader, w, h, blurSigma);
      surface.flush();
      const image = surface.makeImageSnapshot();
      const read = linearShader(e.ck, image);
      passes.set(read, { image, surface });
      return read;
    },
    release: (made) => {
      const pass = passes.get(made);
      made.delete();
      if (pass) {
        pass.image.delete();
        pass.surface.delete();
        passes.delete(made);
      }
    },
  };
}

/** The pixels of a decoded picture drawn at w×h (smaller than it is). */
function pixelsAt(picture: Decoded, w: number, h: number): Uint8ClampedArray {
  const canvas = glCanvas();
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('The picture could not be drawn.');
  ctx.drawImage(picture, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** The recipe over a decoded picture: its pixels (RGBA), and their size. */
function adjustedPixels(
  e: Engine,
  picture: Decoded,
  a: PictureAdjust,
): { pixels: Uint8ClampedArray; w: number; h: number } {
  const { ck } = e;
  const size = sizeOf(picture);
  if (!size.w || !size.h) throw new Error('The picture is empty.');
  const fit = Math.min(1, e.maxSide / Math.max(size.w, size.h));
  const w = Math.max(1, Math.round(size.w * fit));
  const h = Math.max(1, Math.round(size.h * fit));
  const info = {
    width: w,
    height: h,
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  };
  // The picture as a texture: handed over as it was decoded, or — one too large for a texture — as the
  // pixels of a smaller drawing of it.
  const image =
    fit < 1
      ? ck.MakeImage(info, pixelsAt(picture, w, h), w * 4)
      : ck.MakeLazyImageFromTextureSource(picture, { ...info, alphaType: ck.AlphaType.Premul });
  if (!image) throw new Error('The picture could not be read.');
  const base = linearShader(ck, image);
  const kit = glKit(e, w, h);
  let surface: Surface | null = null;
  let temps: Shader[] = [];
  try {
    const made = composeAdjusted({ kind: 'image', shader: base, width: w }, a, kit);
    temps = made.temps;
    surface = renderTarget(e, w, h);
    const canvas = surface.getCanvas();
    drawOnce(ck, canvas, made.shader, w, h);
    surface.flush();
    const read = canvas.readPixels(0, 0, info);
    if (!read) throw new Error('The picture could not be read back.');
    return { pixels: new Uint8ClampedArray(read as Uint8Array), w, h };
  } finally {
    temps.forEach(kit.release);
    surface?.delete();
    base.delete();
    image.delete();
  }
}

/**
 * The job done: the picture with the settings on it, as a JPEG blob of the picture's own size (one over
 * MAX_SIDE comes out that size). With nothing to adjust the picture itself comes back. Rejects when the
 * picture cannot be decoded, or there is no WebGL to run the recipe on.
 */
export async function makeAdjustedFrame(job: AdjustFrameJob): Promise<Blob> {
  if (!isAdjusted(job.adjust)) return job.picture;
  const e = await engineOf();
  const picture = await decode(job.picture);
  let made: { pixels: Uint8ClampedArray; w: number; h: number };
  try {
    made = adjustedPixels(e, picture, job.adjust);
  } finally {
    release(picture);
  }
  return encode(made.pixels, made.w, made.h);
}
