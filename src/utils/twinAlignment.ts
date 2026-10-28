/**
 * Does the twin line up with the thermal frame? (docs/digital-twin-plan.md §43.4, the verifier.) The
 * model, seen from the registered frame's camera, is an ID image: which part each thermal pixel falls
 * on (the viewer frame's ID pass, a `verified` message; the Node runner's raycast for the eval). The
 * thermal frame itself holds the objects a bench experiment is about as patches that stand out from the
 * bench — cold dishes on a warm table, a hot cup on a cold one. This module segments the frame into
 * those patches, lines them up with the model and scores the fit, object by object: how much they
 * overlap (IoU), how far apart their centres are (pixels) and how their sizes compare.
 *
 * A model's object is seldom one part: a dish is a plastic base, a rim and the ice in it, three parts
 * (or three meshes of one part), and a part may span two objects (the model called both dishes'
 * ice `iceSamples`). So the ID image is first cut into part INSTANCES — the connected pieces of each
 * part — and an object of the frame is matched to the union of the instances that lie mostly inside
 * it, whatever they are called. A part that spans several objects is reported, not penalised: it is a
 * fault of the temperature table (one value for two dishes), not of the geometry.
 *
 * Pure functions over typed arrays, unit-tested; the viewer draws the overlay from `overlayRgba` and
 * the panel shows the rest. What it cannot tell: a frame without thermal contrast (a metal ruler
 * reflecting the room, a bench of one temperature) has nothing to segment, and the verdict is
 * `inconclusive` rather than a score — never a pass or a fail the data does not support (plan §43.7).
 */

export const ALIGN_W = 120;
export const ALIGN_H = 160;

/** A patch of the thermal frame that stands apart from the bench: its pixels, centre and extent. */
export interface ThermalBlob {
  id: number; // 1-based label in `labels`
  area: number; // pixels
  cx: number; // centroid, grid pixels (centres at i + 0.5)
  cy: number;
  bbox: [number, number, number, number]; // x0, y0, x1, y1 (exclusive)
  rEq: number; // radius of the circle of the same area, pixels
  meanC: number; // its pixels' mean temperature
}

export interface ThermalSegmentation {
  w: number;
  h: number;
  /** Per pixel: the blob it belongs to (1-based), 0 for the bench, the sky and unreadable pixels. */
  labels: Uint16Array;
  blobs: ThermalBlob[];
  /** The Otsu threshold the frame split at, °C, and which side the objects lie on. */
  thresholdC: number;
  polarity: 'cold' | 'hot';
  /** How well the two classes separate: the gap between their means over their pooled spread (Infinity
   *  when both are flat). Below MIN_CONTRAST the frame has no objects to speak of. */
  contrast: number;
  /** The gap between the two classes' means, °C. */
  gapC: number;
  /** Why there are no blobs, when the frame rather than the scene is the reason; null when there are
   *  blobs, or there could have been. */
  weak: string | null;
  readable: number; // pixels with a temperature
}

/** The patches must stand this far apart from the bench, in pooled standard deviations… */
export const MIN_CONTRAST = 1.5;
/** …and this far in degrees: Otsu splits any frame in two, noise included, so a split narrower than the
 *  camera's own noise plus a little is no split (a frame of one temperature; a gentle gradient). */
export const MIN_GAP_C = 2;
/** The objects' class may hold at most this share of the readable pixels: past it the "objects" are half
 *  the frame — a gradient across the bench, or a frame that is all object and no bench. */
export const MAX_OBJECT_SHARE = 0.45;
/** A patch smaller than this is noise (0.2 % of the frame). */
export const MIN_BLOB_PX = 40;
/** A part instance covering more than this share of the frame is the bench or the ground, not an object. */
export const BACKGROUND_SHARE = 0.6;
/** An instance belongs to the object it lies at least this much inside. */
export const NESTED_SHARE = 0.5;

/** The thresholds a fit must meet, per object (plan §43.4; to be tuned on the regression set). */
export const ALIGN_PASS = { iou: 0.7, centroidPx: 3, areaRatio: [0.8, 1.25] as const };

/** Otsu's threshold over the readable pixels: the split that best separates two classes by variance. */
function otsu(values: number[]): number {
  const n = values.length;
  const min = values[0];
  const max = values[n - 1];
  const BINS = 256;
  if (!(max > min)) return min;
  const hist = new Float64Array(BINS);
  const binOf = (v: number) => Math.min(BINS - 1, Math.floor(((v - min) / (max - min)) * BINS));
  for (const v of values) hist[binOf(v)]++;
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestBin = 0;
  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestBin = i;
    }
  }
  return min + ((bestBin + 1) / BINS) * (max - min);
}

/** 4-connected components of the pixels where `same(k)` holds, within one value of `value`: labels 1-based
 *  in scan order over the output, 0 elsewhere. `value` tells pixels of different parts apart. */
function components(value: ArrayLike<number>, w: number, h: number): { labels: Uint16Array; count: number } {
  const labels = new Uint16Array(w * h);
  const stack: number[] = [];
  let count = 0;
  for (let s = 0; s < w * h; s++) {
    if (!value[s] || labels[s]) continue;
    const v = value[s];
    count++;
    labels[s] = count;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop() as number;
      const x = k % w;
      const y = (k - x) / w;
      const near = [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1];
      for (const nk of near) {
        if (nk < 0 || value[nk] !== v || labels[nk]) continue;
        labels[nk] = count;
        stack.push(nk);
      }
    }
  }
  return { labels, count };
}

interface Region {
  id: number;
  area: number;
  cx: number;
  cy: number;
  bbox: [number, number, number, number];
  rEq: number;
  meanC: number;
}

function regionStats(labels: Uint16Array, count: number, w: number, h: number, temps?: ArrayLike<number>): Region[] {
  const area = new Float64Array(count + 1);
  const sx = new Float64Array(count + 1);
  const sy = new Float64Array(count + 1);
  const st = new Float64Array(count + 1);
  const x0 = new Int32Array(count + 1).fill(w);
  const y0 = new Int32Array(count + 1).fill(h);
  const x1 = new Int32Array(count + 1).fill(-1);
  const y1 = new Int32Array(count + 1).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      area[l]++;
      sx[l] += x + 0.5;
      sy[l] += y + 0.5;
      if (temps) st[l] += temps[y * w + x];
      if (x < x0[l]) x0[l] = x;
      if (y < y0[l]) y0[l] = y;
      if (x + 1 > x1[l]) x1[l] = x + 1;
      if (y + 1 > y1[l]) y1[l] = y + 1;
    }
  }
  const out: Region[] = [];
  for (let l = 1; l <= count; l++) {
    if (!area[l]) continue;
    out.push({
      id: l,
      area: area[l],
      cx: sx[l] / area[l],
      cy: sy[l] / area[l],
      bbox: [x0[l], y0[l], x1[l], y1[l]],
      rEq: Math.sqrt(area[l] / Math.PI),
      meanC: temps ? st[l] / area[l] : NaN,
    });
  }
  return out;
}

/**
 * The frame's objects: the readable pixels split at Otsu's threshold; the smaller class (by pixel count)
 * is the objects, the larger the bench; its 4-connected patches of at least MIN_BLOB_PX pixels are the
 * blobs, largest first and relabelled 1..n in that order. NaN is a masked pixel (the sky, unreadable).
 */
export function segmentThermal(temps: ArrayLike<number>, w = ALIGN_W, h = ALIGN_H): ThermalSegmentation {
  const n = w * h;
  const values: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = temps[k];
    if (t === t) values.push(t);
  }
  const empty = (weak: string): ThermalSegmentation => ({
    w,
    h,
    labels: new Uint16Array(n),
    blobs: [],
    thresholdC: NaN,
    polarity: 'cold',
    contrast: 0,
    gapC: 0,
    weak,
    readable: values.length,
  });
  if (values.length < MIN_BLOB_PX * 2) return empty('the frame has too few readable pixels');
  values.sort((a, b) => a - b);
  const thresholdC = otsu(values);
  // The two classes and how far apart they stand.
  let nLo = 0;
  let nHi = 0;
  let sLo = 0;
  let sHi = 0;
  for (const v of values) {
    if (v < thresholdC) {
      nLo++;
      sLo += v;
    } else {
      nHi++;
      sHi += v;
    }
  }
  if (!nLo || !nHi) return { ...empty('the frame is one temperature'), thresholdC };
  const mLo = sLo / nLo;
  const mHi = sHi / nHi;
  let vLo = 0;
  let vHi = 0;
  for (const v of values) {
    if (v < thresholdC) vLo += (v - mLo) * (v - mLo);
    else vHi += (v - mHi) * (v - mHi);
  }
  const pooled = Math.sqrt((vLo + vHi) / Math.max(1, values.length - 2));
  const gapC = mHi - mLo;
  const contrast = pooled > 1e-6 ? gapC / pooled : gapC > 0 ? Infinity : 0;
  const polarity: 'cold' | 'hot' = nLo <= nHi ? 'cold' : 'hot';
  const share = Math.min(nLo, nHi) / values.length;
  const weak =
    gapC < MIN_GAP_C
      ? `nothing in the frame stands apart from the bench (the frame splits ${gapC.toFixed(1)} °C apart, below ${MIN_GAP_C} °C)`
      : contrast < MIN_CONTRAST
        ? `nothing in the frame stands apart from the bench (contrast ${contrast.toFixed(1)}, below ${MIN_CONTRAST})`
        : share > MAX_OBJECT_SHARE
          ? `the frame has no distinct objects (${Math.round(share * 100)} % of it is on the ${polarity} side of the split)`
          : null;
  if (weak) return { ...empty(weak), thresholdC, polarity, contrast, gapC };
  const mask = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const t = temps[k];
    if (!(t === t)) continue;
    mask[k] = polarity === 'cold' ? (t < thresholdC ? 1 : 0) : t >= thresholdC ? 1 : 0;
  }
  const { labels: raw, count } = components(mask, w, h);
  const stats = regionStats(raw, count, w, h, temps).filter((b) => b.area >= MIN_BLOB_PX);
  stats.sort((a, b) => b.area - a.area);
  const relabel = new Uint16Array(count + 1);
  stats.forEach((b, i) => (relabel[b.id] = i + 1));
  const labels = new Uint16Array(n);
  for (let k = 0; k < n; k++) labels[k] = relabel[raw[k]];
  const blobs = stats.map((b, i) => ({ ...b, id: i + 1 }));
  return {
    w,
    h,
    labels,
    blobs,
    thresholdC,
    polarity,
    contrast,
    gapC,
    weak: blobs.length ? null : 'the frame shows no patch large enough to be an object',
    readable: values.length,
  };
}

/** One connected piece of one part of the model, as the ID image shows it. */
export interface PartInstance {
  id: number; // its label in `labels`, 1-based
  name: string; // the part's name
  instance: number; // which piece of the part, 1-based, largest first
  area: number;
  cx: number;
  cy: number;
  bbox: [number, number, number, number];
  rEq: number;
  /** Covers more than BACKGROUND_SHARE of the frame: the bench, left out of the matching. */
  background: boolean;
}

export interface PartInstances {
  instances: PartInstance[];
  /** Per pixel: the instance's id, 0 for none. */
  labels: Uint16Array;
}

/** The model as the ID image shows it, cut into part instances: `mask` holds a part's index per grid
 *  pixel (0: nothing), `names` the part names by index. Each part's 4-connected pieces become instances,
 *  largest first; a part without a pixel has none. */
export function partInstances(
  mask: ArrayLike<number>,
  names: readonly string[],
  w = ALIGN_W,
  h = ALIGN_H,
): PartInstances {
  const { labels: raw, count } = components(mask, w, h);
  const stats = regionStats(raw, count, w, h);
  // Which part each raw label belongs to: the first pixel's value.
  const partOf = new Uint16Array(count + 1);
  for (let k = 0; k < w * h; k++) if (raw[k] && !partOf[raw[k]]) partOf[raw[k]] = mask[k];
  const ordered = stats.slice().sort((a, b) => partOf[a.id] - partOf[b.id] || b.area - a.area);
  const relabel = new Uint16Array(count + 1);
  const instances: PartInstance[] = [];
  let lastPart = -1;
  let nth = 0;
  ordered.forEach((r) => {
    const part = partOf[r.id];
    nth = part === lastPart ? nth + 1 : 1;
    lastPart = part;
    const id = instances.length + 1;
    relabel[r.id] = id;
    instances.push({
      id,
      name: names[part] ?? `part ${part}`,
      instance: nth,
      area: r.area,
      cx: r.cx,
      cy: r.cy,
      bbox: r.bbox,
      rEq: r.rEq,
      background: r.area > BACKGROUND_SHARE * w * h,
    });
  });
  const labels = new Uint16Array(w * h);
  for (let k = 0; k < w * h; k++) labels[k] = relabel[raw[k]];
  return { instances, labels };
}

export interface ObjectAlignment {
  blob: ThermalBlob;
  /** The instances that lie mostly inside the object, largest first; empty when the model has nothing there. */
  instances: PartInstance[];
  /** The part names among them, each once. */
  parts: string[];
  iou: number; // the object against the union of its instances
  centroidErrPx: number; // NaN without instances
  areaRatio: number; // union / blob; NaN without instances
  pass: boolean;
}

export interface AlignmentReport {
  verdict: 'pass' | 'fail' | 'inconclusive';
  /** Why the frame could not be judged, when it could not. */
  reason?: string;
  objects: ObjectAlignment[];
  /** Objects the model has nothing under. */
  missing: ThermalBlob[];
  /** Instances (not the bench, at least MIN_BLOB_PX) that lie over no object of the frame. */
  extra: PartInstance[];
  /** Parts whose instances lie in more than one object: one name — and, in the measured table, one
   *  value — for several things. Reported, not penalised. */
  shared: { name: string; objects: number }[];
  /** The worst centroid error among matched objects, pixels — what the panel's one line says. */
  worstCentroidPx: number;
  segmentation: ThermalSegmentation;
  instances: PartInstance[];
}

/** Score the model against the frame: every instance goes to the object it lies at least NESTED_SHARE
 *  inside (none: it is extra, if it is big enough), and each object is judged against the union of its
 *  instances by ALIGN_PASS. */
export function alignmentReport(segmentation: ThermalSegmentation, model: PartInstances): AlignmentReport {
  const { w, h, labels, blobs } = segmentation;
  const n = w * h;
  const instances = model.instances;
  const base = {
    segmentation,
    instances,
    objects: [] as ObjectAlignment[],
    missing: [] as ThermalBlob[],
    extra: [] as PartInstance[],
    shared: [] as { name: string; objects: number }[],
    worstCentroidPx: 0,
  };
  if (!blobs.length) {
    return { ...base, verdict: 'inconclusive', reason: segmentation.weak ?? 'the frame shows no object' };
  }
  const candidates = instances.filter((p) => !p.background);
  if (!candidates.length)
    return { ...base, verdict: 'inconclusive', reason: 'the model has no part besides the bench to line up' };
  // Intersections: instance × blob pixel counts.
  const inter = new Map<number, Map<number, number>>(); // instance id -> blob id -> pixels
  for (let k = 0; k < n; k++) {
    const b = labels[k];
    const p = model.labels[k];
    if (!b || !p) continue;
    let row = inter.get(p);
    if (!row) inter.set(p, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  }
  // Each instance's home: the blob it lies mostly inside.
  const home = new Map<number, number>(); // instance id -> blob id
  const homeInter = new Map<number, number>(); // instance id -> pixels inside its home
  for (const p of candidates) {
    const row = inter.get(p.id);
    if (!row) continue;
    let best = 0;
    let bestBlob = 0;
    for (const [b, px] of row) {
      if (px > best) {
        best = px;
        bestBlob = b;
      }
    }
    if (best >= NESTED_SHARE * p.area) {
      home.set(p.id, bestBlob);
      homeInter.set(p.id, best);
    }
  }
  const objects: ObjectAlignment[] = [];
  const missing: ThermalBlob[] = [];
  const perPart = new Map<string, Set<number>>();
  let worst = 0;
  for (const blob of blobs) {
    const mine = candidates.filter((p) => home.get(p.id) === blob.id).sort((a, b) => b.area - a.area);
    if (!mine.length) {
      missing.push(blob);
      objects.push({ blob, instances: [], parts: [], iou: 0, centroidErrPx: NaN, areaRatio: NaN, pass: false });
      continue;
    }
    let uArea = 0;
    let uInter = 0;
    let ux = 0;
    let uy = 0;
    for (const p of mine) {
      uArea += p.area;
      uInter += homeInter.get(p.id) ?? 0;
      ux += p.cx * p.area;
      uy += p.cy * p.area;
      let set = perPart.get(p.name);
      if (!set) perPart.set(p.name, (set = new Set()));
      set.add(blob.id);
    }
    const iou = uInter / (blob.area + uArea - uInter);
    const centroidErrPx = Math.hypot(ux / uArea - blob.cx, uy / uArea - blob.cy);
    const areaRatio = uArea / blob.area;
    const pass =
      iou >= ALIGN_PASS.iou &&
      centroidErrPx <= ALIGN_PASS.centroidPx &&
      areaRatio >= ALIGN_PASS.areaRatio[0] &&
      areaRatio <= ALIGN_PASS.areaRatio[1];
    worst = Math.max(worst, centroidErrPx);
    objects.push({
      blob,
      instances: mine,
      parts: [...new Set(mine.map((p) => p.name))],
      iou,
      centroidErrPx,
      areaRatio,
      pass,
    });
  }
  const extra = candidates.filter((p) => !home.has(p.id) && p.area >= MIN_BLOB_PX);
  const shared = [...perPart].filter(([, set]) => set.size > 1).map(([name, set]) => ({ name, objects: set.size }));
  const verdict: AlignmentReport['verdict'] =
    !missing.length && !extra.length && objects.every((o) => o.pass) ? 'pass' : 'fail';
  return { ...base, verdict, objects, missing, extra, shared, worstCentroidPx: worst };
}

/** The overlay the panel draws: the frame's blobs in red, the model's instances (the bench excluded) in
 *  blue, where both agree in purple, over a faint grey of the bench; RGBA, w × h, rows from the top. */
export function overlayRgba(segmentation: ThermalSegmentation, model: PartInstances): Uint8ClampedArray {
  const { w, h, labels } = segmentation;
  const background = new Set(model.instances.filter((p) => p.background).map((p) => p.id));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    const b = labels[k] > 0;
    const p = model.labels[k] > 0 && !background.has(model.labels[k]);
    const o = k * 4;
    if (b && p) {
      out[o] = 170;
      out[o + 1] = 60;
      out[o + 2] = 200;
    } else if (b) {
      out[o] = 230;
      out[o + 1] = 70;
      out[o + 2] = 70;
    } else if (p) {
      out[o] = 70;
      out[o + 1] = 120;
      out[o + 2] = 230;
    } else {
      out[o] = out[o + 1] = out[o + 2] = 40;
    }
    out[o + 3] = 255;
  }
  return out;
}

/** One line for the panel. */
export function alignmentSentence(r: AlignmentReport): string {
  if (r.verdict === 'inconclusive') return `Alignment not checked: ${r.reason ?? 'the frame could not be judged'}.`;
  const n = r.objects.length;
  const matched = r.objects.filter((o) => o.instances.length);
  const parts: string[] = [];
  if (matched.length)
    parts.push(`${matched.length} of ${n} object${n === 1 ? '' : 's'} within ${r.worstCentroidPx.toFixed(1)} px`);
  if (r.missing.length)
    parts.push(`${r.missing.length} with nothing under ${r.missing.length === 1 ? 'it' : 'them'} on the model`);
  if (r.extra.length)
    parts.push(
      `${r.extra.length} part${r.extra.length === 1 ? '' : 's'} with nothing under ${r.extra.length === 1 ? 'it' : 'them'} in the frame`,
    );
  if (r.shared.length) parts.push(r.shared.map((s) => `${s.name} is one part over ${s.objects} objects`).join(', '));
  return (r.verdict === 'pass' ? 'Aligned: ' : 'Misaligned: ') + parts.join('; ') + '.';
}
