/**
 * Visible→thermal registration for the 3D digital twin (docs/digital-twin-plan.md §6.1).
 *
 * The capture app's visible photo and thermal render come from one FLIR Fusion object, so they are
 * nominally pixel-aligned — but the two lenses sit a couple of centimetres apart and the factory
 * alignment is right at one distance only. At lab distances the residual is tens of visible pixels,
 * enough to paint a beaker's temperatures onto the table next to it. This measures the residual on the
 * reference frame so the client can shift the model's (visible-frame) boxes onto the thermal grid.
 *
 * Everything works on the 120×160 thermal grid as edge maps:
 *   1. T  = shift between the visible photo's edges and the MSX blend's edges (the visible edges as the
 *           SDK drew them into the thermal frame) — same content, robust;
 *   2. e  = residual shift between those SDK-placed edges and the thermal image's own edges (where the
 *           objects really are in the thermal frame) — cross-modal, so it is gated by its score;
 *   total = T + e (or T alone, or a direct visible↔thermal estimate when no blend exists).
 * The result is in thermal pixels: a visible feature at (u, v) appears in the thermal frame at
 * (u + dx, v + dy). Dependency-free; the caller decodes the images.
 */

export interface Gray {
  data: Float32Array; // row-major
  width: number;
  height: number;
}

export interface Registration {
  dx: number;
  dy: number;
  score: number; // peak normalised cross-correlation of the decisive step, 0..1
  method: 'vis-mix-thermal' | 'vis-mix' | 'vis-thermal';
}

/** Search windows (thermal px) and score gates. The SDK's own misplacement can be large (tens of
 *  visible px ≈ up to ~10 thermal px); the cross-modal residual is small by construction. */
export const REG_SEARCH_MIX_PX = 12;
export const REG_SEARCH_RESIDUAL_PX = 6;
export const REG_MIN_SCORE_SAME = 0.3;
export const REG_MIN_SCORE_CROSS = 0.18;

/** Luma from an RGBA buffer (jpeg-js / pngjs layout). */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return { data, width, height };
}

/** Area-average resample to (width × height). Meant for downscaling (a 1080×1440 photo to 120×160);
 *  each target pixel averages the source rectangle it covers. */
export function resampleGray(src: Gray, width: number, height: number): Gray {
  if (src.width === width && src.height === height) return src;
  const out = new Float32Array(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let s = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * src.width;
        for (let xx = x0; xx < x1; xx++) {
          s += src.data[row + xx];
          n++;
        }
      }
      out[y * width + x] = n ? s / n : 0;
    }
  }
  return { data: out, width, height };
}

/** Gradient magnitude by central differences (edge-clamped). Values far below any temperature (the
 *  truncated-frame sentinel) are clamped first so one corrupt row does not become the strongest edge. */
export function gradientMagnitude(g: Gray): Gray {
  const { width: w, height: h } = g;
  const src = new Float32Array(g.data.length);
  for (let i = 0; i < src.length; i++) src[i] = g.data[i] < -100 ? -50 : g.data[i];
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const yp = Math.min(h - 1, y + 1) * w;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const gx = src[row + xp] - src[row + xm];
      const gy = src[yp + x] - src[ym + x];
      out[row + x] = Math.hypot(gx, gy);
    }
  }
  return { data: out, width: w, height: h };
}

/** Unit-variance, clipped at ±3σ so a few very strong edges do not dominate the correlation, then
 *  re-centred to zero mean (edge maps are sparse and heavy-tailed, so the clip shifts the mean) — the
 *  dot products in nccShift are then true correlation coefficients. */
export function normalizeEdges(g: Gray): Gray {
  const n = g.data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += g.data[i];
  mean /= n || 1;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (g.data[i] - mean) ** 2;
  const sd = Math.sqrt(varSum / (n || 1)) || 1;
  const out = new Float32Array(n);
  let clippedMean = 0;
  for (let i = 0; i < n; i++) {
    const v = (g.data[i] - mean) / sd;
    out[i] = v > 3 ? 3 : v < -3 ? -3 : v;
    clippedMean += out[i];
  }
  clippedMean /= n || 1;
  for (let i = 0; i < n; i++) out[i] -= clippedMean;
  return { data: out, width: g.width, height: g.height };
}

/** Integer-shift a map: out(x, y) = g(x − dx, y − dy), zero where the source is out of range. */
export function shiftGray(g: Gray, dx: number, dy: number): Gray {
  const { width: w, height: h } = g;
  const out = new Float32Array(w * h);
  const ix = Math.round(dx);
  const iy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - ix;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = g.data[sy * w + sx];
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Best (dx, dy) with b(x, y) ≈ a(x − dx, y − dy) by normalised cross-correlation over every integer
 * shift within ±maxShift, refined to sub-pixel by a parabola through the peak. Same estimator as the
 * client's camera-motion gate (src/utils/twinStability.ts), on a full lattice since the maps are small.
 */
export function nccShift(a: Gray, b: Gray, maxShift: number): { dx: number; dy: number; score: number } {
  const { width: w, height: h } = a;
  const size = 2 * maxShift + 1;
  const scores = new Float32Array(size * size).fill(-2);
  let best = -2;
  let bx = 0;
  let by = 0;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    const y0 = Math.max(0, dy);
    const y1 = Math.min(h, h + dy);
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      const x0 = Math.max(0, dx);
      const x1 = Math.min(w, w + dx);
      let sab = 0;
      let saa = 0;
      let sbb = 0;
      for (let y = y0; y < y1; y++) {
        const rowB = y * w;
        const rowA = (y - dy) * w;
        for (let x = x0; x < x1; x++) {
          const va = a.data[rowA + x - dx];
          const vb = b.data[rowB + x];
          sab += va * vb;
          saa += va * va;
          sbb += vb * vb;
        }
      }
      const denom = Math.sqrt(saa * sbb);
      const s = denom > 1e-9 ? sab / denom : 0;
      scores[(dy + maxShift) * size + (dx + maxShift)] = s;
      if (s > best) {
        best = s;
        bx = dx;
        by = dy;
      }
    }
  }
  const at = (dx: number, dy: number) => scores[(dy + maxShift) * size + (dx + maxShift)];
  const refine = (m: number, c: number, p: number, i: number) => {
    const d = m - 2 * c + p;
    return d < 0 ? i + (0.5 * (m - p)) / d : i;
  };
  let dx = bx;
  let dy = by;
  if (Math.abs(bx) < maxShift) dx = refine(at(bx - 1, by), best, at(bx + 1, by), bx);
  if (Math.abs(by) < maxShift) dy = refine(at(bx, by - 1), best, at(bx, by + 1), by);
  return { dx, dy, score: best };
}

export interface RegistrationInput {
  vis: Gray; // the visible photo, any size
  mix: Gray | null; // the MSX blend, any size (null when the recording has none)
  temps: Float32Array; // the thermal frame, Celsius, thermal-grid size
  width: number; // thermal grid
  height: number;
}

const edges = (g: Gray, w: number, h: number): Gray => normalizeEdges(gradientMagnitude(resampleGray(g, w, h)));

/** Estimate the visible→thermal shift on one frame; null when nothing correlates well enough to trust. */
export function estimateRegistration(input: RegistrationInput): Registration | null {
  const { width: w, height: h } = input;
  const eV = edges(input.vis, w, h);
  const eT = normalizeEdges(gradientMagnitude({ data: input.temps, width: w, height: h }));
  const round2 = (v: number) => Math.round(v * 100) / 100;

  if (input.mix) {
    const eM = edges(input.mix, w, h);
    const t = nccShift(eV, eM, REG_SEARCH_MIX_PX);
    if (t.score >= REG_MIN_SCORE_SAME) {
      const placed = shiftGray(eV, t.dx, t.dy);
      const e = nccShift(placed, eT, REG_SEARCH_RESIDUAL_PX);
      if (e.score >= REG_MIN_SCORE_CROSS) {
        return { dx: round2(t.dx + e.dx), dy: round2(t.dy + e.dy), score: round2(e.score), method: 'vis-mix-thermal' };
      }
      return { dx: round2(t.dx), dy: round2(t.dy), score: round2(t.score), method: 'vis-mix' };
    }
  }
  const direct = nccShift(eV, eT, REG_SEARCH_MIX_PX);
  if (direct.score >= REG_MIN_SCORE_CROSS) {
    return { dx: round2(direct.dx), dy: round2(direct.dy), score: round2(direct.score), method: 'vis-thermal' };
  }
  return null;
}
