/**
 * The pictures a lab report shows the model, made the same way whichever road the recording came in by.
 *
 * A recording reaches generateLabReport two ways: as an UPLOADED experiment, whose frames and
 * visible-light stills sit in Storage at full size (1080 × 1440, ~80 KB each), or as a phone's
 * CONTAINER (app repo proposal §3.A), where the phone has already shrunk the photos, drawn a contact
 * sheet and picked one photo per camera pose. The model must see the same thing either way — the same
 * sizes, the same sheet, the same rule for which instants get a larger photo — or the two roads write
 * different reports for one recording. So the sizes and the rules live here, mirrored from the app's
 * aiReportPack.ts (posePhotoFrames / contactSheetFrames / sheetLabel and the SHEET_* / *_LONG_EDGE
 * constants are the same code), and the server applies them itself to an uploaded recording, and
 * re-applies the size caps to whatever a container brought.
 *
 * The JPEG work is sharp (libvips): a 1080 × 1440 still shrinks on load through the decoder's own
 * DCT scaling in a few milliseconds, where a pure-JS decode of the same still took ~170 ms on a
 * laptop — 48 sheet tiles would have cost the seed eight seconds there and three times that on the
 * function's fractional CPU. The sheet's layout and its time labels (a 5×7 bitmap font: a function
 * has no canvas and no fonts to count on) are drawn on raw RGBA here, and sharp encodes the result.
 * Pure otherwise: bytes in, bytes out, no Storage, no Firestore.
 */
import sharp from 'sharp';

/** Long edge of a pool photo: enough to tell a mug from a kettle, ~10–20 KB. */
export const POOL_PHOTO_LONG_EDGE = 320;
/** Long edge of a pose photo (one per camera position), for reading detail. */
export const POSE_PHOTO_LONG_EDGE = 640;
/** The contact sheet: 6 columns of 120 x 160 tiles, at most 48 of them. */
export const SHEET_COLUMNS = 6;
export const SHEET_TILE_W = 120;
export const SHEET_TILE_H = 160;
export const SHEET_TILES_MAX = 48;

const PHOTO_JPEG_QUALITY = 75;
const SHEET_JPEG_QUALITY = 70;

/**
 * One full-size photo per camera pose: the middle frame of each stable stretch, plus the first and
 * last selected frames so the start and end of the recording are always shown in full. Ascending,
 * unique. Frame numbers are whatever space `picked` and `camera` share (the app's player frames, the
 * server's too).
 */
export function posePhotoFrames(
  camera: { poses: { from: number; to: number }[] },
  picked: readonly number[],
): number[] {
  const out = new Set<number>();
  if (picked.length > 0) {
    out.add(picked[0]);
    out.add(picked[picked.length - 1]);
  }
  for (const p of camera.poses) {
    out.add(Math.floor((p.from + p.to) / 2));
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Which selected frames tile the contact sheet when there are more than fit: the first and last, then
 * an even spread of the rest — the selection is already densest where the recording changed, so an
 * even spread of IT keeps the changes over-represented without a second heuristic.
 */
export function contactSheetFrames(picked: readonly number[], max = SHEET_TILES_MAX): number[] {
  if (picked.length <= max) {
    return [...picked];
  }
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    out.push(picked[Math.round((i * (picked.length - 1)) / (max - 1))]);
  }
  return Array.from(new Set(out));
}

/** "48s" for 48.3 s; minutes past 100 s ("1m40s") to keep labels short. */
export function labelForSeconds(seconds: number): string {
  const sec = Math.round(seconds);
  if (sec < 100) {
    return `${sec}s`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/** The app's form of the same label: frame number at `fps`. */
export function sheetLabel(frame: number, fps: number): string {
  return labelForSeconds((frame - 1) / fps);
}

/** A decoded picture: RGBA, row-major, 4 bytes a pixel. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const asBuffer = (u8: Uint8Array): Buffer => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
const asU8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/**
 * A JPEG's pixel size from its SOF marker alone — no decode. null when the bytes are not a JPEG this
 * reader understands.
 */
export function jpegDimensions(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any SOF
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Decode a picture to RGBA, shrunk on load to fit inside `maxW` × `maxH` (never enlarged; the aspect
 * ratio kept). null when the bytes cannot be read as a picture.
 */
export async function decodeJpegFit(buf: Uint8Array, maxW: number, maxH: number): Promise<Rgba | null> {
  try {
    const { data, info } = await sharp(asBuffer(buf), { failOn: 'none' })
      .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return info.width > 0 && info.height > 0 ? { width: info.width, height: info.height, data: asU8(data) } : null;
  } catch {
    return null;
  }
}

/** Decode a picture to RGBA at its own size, or null when it cannot be read. */
export async function decodeJpegRgba(buf: Uint8Array): Promise<Rgba | null> {
  try {
    const { data, info } = await sharp(asBuffer(buf), { failOn: 'none' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return info.width > 0 && info.height > 0 ? { width: info.width, height: info.height, data: asU8(data) } : null;
  } catch {
    return null;
  }
}

/** Encode RGBA as a JPEG. */
export async function encodeRgbaJpeg(img: Rgba, quality: number): Promise<Uint8Array> {
  const out = await sharp(asBuffer(img.data), { raw: { width: img.width, height: img.height, channels: 4 } })
    .jpeg({ quality })
    .toBuffer();
  return asU8(out);
}

/** The size a `w` × `h` picture takes with its long edge at most `longEdge`, never enlarged. */
export function fitWithin(w: number, h: number, longEdge: number): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= longEdge) return { w, h };
  const s = longEdge / long;
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/**
 * Resample RGBA to `dw` × `dh` in plain JS, for a picture already in hand (a sheet tile that is not
 * yet the tile's size). Shrinking averages every source pixel a destination pixel covers; enlarging
 * is bilinear. Alpha is carried the same way.
 */
export function resizeRgba(src: Rgba, dw: number, dh: number): Rgba {
  const { width: sw, height: sh, data: s } = src;
  if (dw === sw && dh === sh) return { width: sw, height: sh, data: new Uint8Array(s) };
  const out = new Uint8Array(dw * dh * 4);
  const shrinking = dw <= sw && dh <= sh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      if (shrinking) {
        const x0 = Math.floor((x * sw) / dw);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
        const y0 = Math.floor((y * sh) / dh);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let i = (yy * sw + x0) * 4;
          for (let xx = x0; xx < x1; xx++) {
            r += s[i];
            g += s[i + 1];
            b += s[i + 2];
            a += s[i + 3];
            i += 4;
            n += 1;
          }
        }
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = Math.round(a / n);
      } else {
        const fx = ((x + 0.5) * sw) / dw - 0.5;
        const fy = ((y + 0.5) * sh) / dh - 0.5;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        const ty = Math.max(0, Math.min(1, fy - y0));
        const i00 = (y0 * sw + x0) * 4;
        const i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4;
        const i11 = (y1 * sw + x1) * 4;
        for (let c = 0; c < 4; c++) {
          const top = s[i00 + c] * (1 - tx) + s[i10 + c] * tx;
          const bottom = s[i01 + c] * (1 - tx) + s[i11 + c] * tx;
          out[o + c] = Math.round(top * (1 - ty) + bottom * ty);
        }
      }
    }
  }
  return { width: dw, height: dh, data: out };
}

/**
 * A JPEG with its long edge at most `longEdge`: the bytes untouched when they already fit (a photo the
 * phone shrank is not re-encoded), shrunk on load and re-encoded at the pool quality when they do not,
 * null when the bytes cannot be read as a picture.
 */
export async function scaledJpeg(
  buf: Uint8Array,
  longEdge: number,
  quality = PHOTO_JPEG_QUALITY,
): Promise<Uint8Array | null> {
  const dims = jpegDimensions(buf);
  if (dims && Math.max(dims.width, dims.height) <= longEdge) return buf;
  try {
    const out = await sharp(asBuffer(buf), { failOn: 'none' })
      .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    return asU8(out);
  } catch {
    return null;
  }
}

/* A 5×7 bitmap font for the sheet's labels: digits, "m" and "s" are all a label ever holds. */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  m: ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
};
const GLYPH_W = 5;
const GLYPH_H = 7;

/** Width in pixels of `text` drawn at `scale` (one pixel column between glyphs). */
function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * (GLYPH_W + 1) - 1) * scale;
}

function drawText(img: Rgba, text: string, x0: number, y0: number, scale: number): void {
  let x = x0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      for (let r = 0; r < GLYPH_H; r++) {
        for (let c = 0; c < GLYPH_W; c++) {
          if (g[r][c] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            const py = y0 + r * scale + dy;
            if (py < 0 || py >= img.height) continue;
            for (let dx = 0; dx < scale; dx++) {
              const px = x + c * scale + dx;
              if (px < 0 || px >= img.width) continue;
              const o = (py * img.width + px) * 4;
              img.data[o] = 255;
              img.data[o + 1] = 255;
              img.data[o + 2] = 255;
              img.data[o + 3] = 255;
            }
          }
        }
      }
    }
    x += (GLYPH_W + 1) * scale;
  }
}

/** Blend a solid colour at `alpha` (0–1) over a rectangle. */
function fillRect(
  img: Rgba,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
  alpha: number,
): void {
  const x1 = Math.min(img.width, x0 + w);
  const y1 = Math.min(img.height, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.round(img.data[o + c] * (1 - alpha) + rgb[c] * alpha);
      img.data[o + 3] = 255;
    }
  }
}

function strokeRect(img: Rgba, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  fillRect(img, x0, y0, w, 1, rgb, 1);
  fillRect(img, x0, y0 + h - 1, w, 1, rgb, 1);
  fillRect(img, x0, y0, 1, h, rgb, 1);
  fillRect(img, x0 + w - 1, y0, 1, h, rgb, 1);
}

export interface SheetTile {
  /** The picture, or null when it could not be had: the tile stays black but keeps its label. */
  picture: Rgba | null;
  label: string;
}

/**
 * The contact sheet the app's packer draws (AiReportPacker.contactSheet), as pixels: `SHEET_COLUMNS`
 * columns of `SHEET_TILE_W` × `SHEET_TILE_H` tiles on black, each picture fitted inside its tile and
 * centred, a dark-grey one-pixel frame, and the label in white on a translucent black box at the
 * tile's top-left. null when not one tile has a picture.
 */
export function contactSheetRgba(
  tiles: readonly SheetTile[],
  opts: { columns?: number; tileW?: number; tileH?: number } = {},
): Rgba | null {
  const cols = Math.max(1, opts.columns ?? SHEET_COLUMNS);
  const tw = Math.max(16, opts.tileW ?? SHEET_TILE_W);
  const th = Math.max(16, opts.tileH ?? SHEET_TILE_H);
  if (tiles.length === 0) return null;
  const rows = Math.ceil(tiles.length / cols);
  const sheet: Rgba = { width: cols * tw, height: rows * th, data: new Uint8Array(cols * tw * rows * th * 4) };
  for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
  // The app's text is th/8 px high, clamped to 12–24: the nearest whole multiple of the 7-px glyph.
  const scale = Math.max(1, Math.round(Math.max(12, Math.min(24, th / 8)) / GLYPH_H));
  let drawn = 0;
  tiles.forEach((tile, i) => {
    const x = (i % cols) * tw;
    const y = Math.floor(i / cols) * th;
    const pic = tile.picture;
    if (pic && pic.width > 0 && pic.height > 0) {
      const s = Math.min(tw / pic.width, th / pic.height);
      const w = Math.max(1, Math.round(pic.width * s));
      const h = Math.max(1, Math.round(pic.height * s));
      const fitted = w === pic.width && h === pic.height ? pic : resizeRgba(pic, w, h);
      const ox = x + Math.floor((tw - w) / 2);
      const oy = y + Math.floor((th - h) / 2);
      for (let yy = 0; yy < h; yy++) {
        sheet.data.set(fitted.data.subarray(yy * w * 4, (yy + 1) * w * 4), ((oy + yy) * sheet.width + ox) * 4);
      }
      drawn += 1;
    }
    strokeRect(sheet, x, y, tw, th, [68, 68, 68]);
    if (tile.label) {
      const pad = 3;
      const bw = textWidth(tile.label, scale) + 2 * pad;
      const bh = GLYPH_H * scale + 2 * pad;
      fillRect(sheet, x, y, bw, bh, [0, 0, 0], 170 / 255);
      drawText(sheet, tile.label, x + pad, y + pad, scale);
    }
  });
  return drawn > 0 ? sheet : null;
}

/** The contact sheet as a JPEG, or null when no tile had a picture. */
export async function contactSheetJpeg(tiles: readonly SheetTile[]): Promise<Uint8Array | null> {
  const sheet = contactSheetRgba(tiles);
  return sheet ? encodeRgbaJpeg(sheet, SHEET_JPEG_QUALITY) : null;
}
