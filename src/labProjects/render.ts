/*
 * Pictures the browser makes for the AI: a thermal frame drawn from its
 * temperatures with a fixed colour scale (and the scale's °C labels beside
 * it), a visible-light frame scaled down, and a contact sheet of a take.
 * The website's version of the app's lib/labProjects/render.ts, drawn with
 * Canvas 2D instead of Skia — the same pixel sizes, palette (iron), fonts,
 * scale bar and JPEG quality, because the model compares these pictures
 * across turns and devices. The chart (renderChartPng) is not here: the
 * chart tool is not on the website.
 */

import { SHEET_COLUMNS } from './core/overviewTiles';
import { paletteRgba } from './heatmap';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './recordingFormat';

/** The Skia build names 'sans-serif' (Android) or Helvetica (iOS); the browser's sans-serif is the nearest. */
const FONT_FAMILY = 'sans-serif';
const PALETTE = 'iron';

export interface Mark {
  label: string;
  /** Point, or the centre of an area. Fractions of the image. */
  x?: number;
  y?: number;
  shape?: 'point' | 'rect' | 'ellipse';
  w?: number;
  h?: number;
  /** A temperature line. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

function canvasOf(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not draw the picture.');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  return { canvas, ctx };
}

/** The frame's pixels through the palette, as a 120 × 160 canvas to scale from; null for an unknown palette. */
function thermalImage(celsius: Float32Array | readonly number[], min: number, max: number): HTMLCanvasElement | null {
  const rgba = paletteRgba(celsius, min, max, PALETTE);
  if (!rgba) {
    return null;
  }
  const { canvas, ctx } = canvasOf(IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT);
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      IR_ARRAY_WIDTH,
      IR_ARRAY_HEIGHT,
    ),
    0,
    0,
  );
  return canvas;
}

/** A w × h ramp of the palette, `values` along its long side. */
function rampImage(values: Float32Array, min: number, max: number, w: number, h: number): HTMLCanvasElement | null {
  const rgba = paletteRgba(values, min, max, PALETTE);
  if (!rgba) {
    return null;
  }
  const { canvas, ctx } = canvasOf(w, h);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
  return canvas;
}

const fmtC = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)} °C`;

/** The canvas as base64 JPEG (no data: prefix) at `quality` (0–1). */
function jpegOf(canvas: HTMLCanvasElement, quality: number): string {
  const url = canvas.toDataURL('image/jpeg', quality);
  const at = url.indexOf(',');
  return at >= 0 ? url.slice(at + 1) : '';
}

/**
 * A thermal frame at 4× (480 × 640) under a title line, with the colour scale
 * and its labels on the right and, optionally, the take's sensors drawn on it.
 * Returns base64 JPEG.
 */
export function renderThermalJpeg(opts: {
  celsius: Float32Array | readonly number[];
  min: number;
  max: number;
  title: string;
  marks?: Mark[];
}): string {
  const scale = 4;
  const imgW = IR_ARRAY_WIDTH * scale;
  const imgH = IR_ARRAY_HEIGHT * scale;
  const top = 40;
  const barW = 26;
  const panelW = 120;
  const W = imgW + panelW;
  const H = imgH + top;
  const { canvas, ctx } = canvasOf(W, H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.font = `22px ${FONT_FAMILY}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(opts.title, 10, 28);

  const img = thermalImage(opts.celsius, opts.min, opts.max);
  if (img) {
    ctx.drawImage(img, 0, 0, IR_ARRAY_WIDTH, IR_ARRAY_HEIGHT, 0, top, imgW, imgH);
  }

  // the colour scale: hottest at the top
  const ramp = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    ramp[i] = opts.max - ((opts.max - opts.min) * i) / 255;
  }
  const rampImg = rampImage(ramp, opts.min, opts.max, 1, 256);
  if (rampImg) {
    ctx.drawImage(rampImg, 0, 0, 1, 256, imgW + 12, top + 10, barW, imgH - 20);
  }
  const labelX = imgW + 12 + barW + 6;
  const ticks = 5;
  ctx.font = `19px ${FONT_FAMILY}`;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let k = 0; k < ticks; k++) {
    const f = k / (ticks - 1);
    const v = opts.max - (opts.max - opts.min) * f;
    const y = top + 10 + (imgH - 20) * f;
    ctx.beginPath();
    ctx.moveTo(imgW + 12 + barW, y);
    ctx.lineTo(imgW + 12 + barW + 4, y);
    ctx.stroke();
    ctx.fillText(fmtC(v).replace(' °C', ''), labelX, y + 7);
  }
  ctx.fillText('°C', labelX, top + imgH - 2);

  // sensors
  if (opts.marks && opts.marks.length > 0) {
    const px = (fx: number) => fx * imgW;
    const py = (fy: number) => top + fy * imgH;
    const strokeTwice = (draw: () => void) => {
      // a black shadow under the white stroke, so a mark reads on any colour
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 6;
      draw();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      draw();
    };
    for (const m of opts.marks) {
      let lx = 0;
      let ly = 0;
      if (m.x1 != null && m.y1 != null && m.x2 != null && m.y2 != null) {
        const [ax, ay, bx, by] = [px(m.x1), py(m.y1), px(m.x2), py(m.y2)];
        strokeTwice(() => {
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        });
        lx = bx + 6;
        ly = by;
      } else if (m.x != null && m.y != null) {
        const cx = px(m.x);
        const cy = py(m.y);
        if ((m.shape === 'rect' || m.shape === 'ellipse') && m.w && m.h) {
          const rw = m.w * imgW;
          const rh = m.h * imgH;
          const rx = cx - rw / 2;
          const ry = cy - rh / 2;
          strokeTwice(() => {
            ctx.beginPath();
            if (m.shape === 'rect') {
              ctx.rect(rx, ry, rw, rh);
            } else {
              ctx.ellipse(cx, cy, rw / 2, rh / 2, 0, 0, Math.PI * 2);
            }
            ctx.stroke();
          });
          lx = cx + rw / 2 + 4;
          ly = cy - rh / 2 + 18;
        } else {
          strokeTwice(() => {
            ctx.beginPath();
            ctx.arc(cx, cy, 9, 0, Math.PI * 2);
            ctx.stroke();
          });
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(cx - 15, cy);
          ctx.lineTo(cx - 10, cy);
          ctx.moveTo(cx + 10, cy);
          ctx.lineTo(cx + 15, cy);
          ctx.stroke();
          lx = cx + 13;
          ly = cy - 10;
        }
      } else {
        continue;
      }
      lx = Math.min(lx, imgW - 60);
      ly = Math.max(top + 20, Math.min(ly, top + imgH - 6));
      ctx.font = `19px ${FONT_FAMILY}`;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 4;
      ctx.strokeText(m.label, lx, ly);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(m.label, lx, ly);
    }
  }
  return jpegOf(canvas, 0.86);
}

/** A visible-light picture scaled so its long edge is at most `maxEdge`, with a title line on top. */
export function renderVisibleJpeg(
  img: CanvasImageSource & { width: number; height: number },
  title: string,
  maxEdge = 640,
): string {
  const w0 = img.width;
  const h0 = img.height;
  if (!(w0 > 0 && h0 > 0)) {
    throw new Error('Could not read the visible-light picture.');
  }
  const k = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const top = 40;
  const { canvas, ctx } = canvasOf(w, h + top);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h + top);
  ctx.drawImage(img, 0, 0, w0, h0, 0, top, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.font = `22px ${FONT_FAMILY}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 10, 28);
  return jpegOf(canvas, 0.84);
}

export type SheetTile =
  | { kind: 'thermal'; celsius: Float32Array; min: number; max: number; label: string }
  | { kind: 'visible'; image: CanvasImageSource & { width: number; height: number }; label: string };

/**
 * Tiles in a grid of 3:4 portrait cells, each twice the thermal grid
 * (240 × 320), with their time under each; base64 JPEG. Three across keeps
 * the sheet under 768 px wide, the short side above which model providers
 * scale a picture down (overviewTiles.ts). A thermal sheet passes its colour
 * scale, drawn as a bar with its °C ends under the title.
 */
export function renderContactSheet(
  tiles: SheetTile[],
  title: string,
  opts: { cols?: number; scale?: { min: number; max: number } } = {},
): string {
  const cols = opts.cols ?? SHEET_COLUMNS;
  const cellW = 240;
  const cellH = 320;
  const labelH = 30;
  const gap = 8;
  const top = opts.scale ? 70 : 40;
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  const W = cols * cellW + (cols + 1) * gap;
  const H = top + rows * (cellH + labelH + gap) + gap;
  const { canvas, ctx } = canvasOf(W, H);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `24px ${FONT_FAMILY}`;
  ctx.fillText(title, gap, 28);
  if (opts.scale) {
    // the colour scale, cold to hot, between its two ends
    const { min, max } = opts.scale;
    const y = 42;
    const labelW = 86;
    const rampW = Math.min(360, W - 2 * gap - 2 * labelW);
    const ramp = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      ramp[i] = min + ((max - min) * i) / 255;
    }
    const rampImg = rampImage(ramp, min, max, 256, 1);
    if (rampImg) {
      ctx.drawImage(rampImg, 0, 0, 256, 1, gap + labelW, y, rampW, 16);
    }
    ctx.font = `20px ${FONT_FAMILY}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fmtC(min), gap, y + 14);
    ctx.fillText(fmtC(max), gap + labelW + rampW + 8, y + 14);
  }
  ctx.font = `20px ${FONT_FAMILY}`;
  tiles.forEach((t, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = gap + c * (cellW + gap);
    const y = top + gap + r * (cellH + labelH + gap);
    const img = t.kind === 'thermal' ? thermalImage(t.celsius, t.min, t.max) : t.image;
    if (img) {
      // fit the picture into the cell, centred
      const iw = img.width;
      const ih = img.height;
      if (iw > 0 && ih > 0) {
        const k = Math.min(cellW / iw, cellH / ih);
        const dw = iw * k;
        const dh = ih * k;
        ctx.drawImage(img, 0, 0, iw, ih, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(t.label, x + 2, y + cellH + 19);
  });
  return jpegOf(canvas, 0.8);
}
