/*
 * What the website tells the AI about a take when it joins the conversation:
 * the same JSON fields and the same contact sheets as the app's takeOverview
 * (lib/labProjects/phoneTools.ts), read from the take's cloud copy
 * (cloudTake.ts) instead of the phone's files. What the cloud copy lacks
 * (`repeatedFrames`, the info.json fields beyond the camera and emissivity)
 * is left out, not made up; `recordedAt` comes from the experiment's
 * startedAt. The user's sensors are the experiment's thermometers and
 * temperature lines in the analyzer.
 */

import { compressSeries, seriesStats, type SeriesPoint } from './core/compress';
import { detectCamera } from './core/frameSelection';
import { MAX_TILES, sheetsOf, tileFrames } from './core/overviewTiles';
import type { OutImage, Take } from './core/types';
import { marksOf, openCloudTake, readFrames, sensorPlace, takeSpan, type CloudTake } from './cloudTake';
import { renderContactSheet, renderThermalJpeg, renderVisibleJpeg, type SheetTile } from './render';

type Json = Record<string, unknown>;

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The most frames a sensor's curve reads for the overview. The phone sweeps
 * every frame of a take from its files; here each frame is a request, so a
 * long take is read in a stride instead and the curve says so
 * (`sampledEveryNthFrame`). 1,200 frames is four minutes of an ordinary
 * recording whole, and a 20-minute one every 5th frame.
 */
export const OVERVIEW_CURVE_MAX_FRAMES = 1200;

/** When the take was recorded, on the local clock, as the app words it; null when the cloud copy does not say. */
function recordedAt(d: CloudTake): string | null {
  if (d.startedAt == null) {
    return null;
  }
  const at = new Date(d.startedAt);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())} local time`;
}

/** The camera's moves and shutter calibrations, from frame-stats.bin when the upload carried it. */
export async function cameraOf(
  d: CloudTake,
): Promise<{ movedDuring: [number, number][]; shutterCalibrationsAt: number[] } | null> {
  const stats = await d.frameStats();
  if (!stats) {
    return null;
  }
  const cam = detectCamera(stats);
  // the detector counts frames from 1; a clipped copy's frames are the recording's, so the times are of the whole take
  return {
    movedDuring: cam.moves.map((m) => [r2(d.timeOf(m.from - 1)), r2(d.timeOf(m.to - 1))]),
    shutterCalibrationsAt: cam.nuc.map((n) => r2(d.timeOf(n - 1))),
  };
}

/** The frames (player indexes) a sensor's curve reads: every one, or every k-th of a long take. */
function curveFrames(frameCount: number): { indexes: number[]; every: number } {
  const every = Math.max(1, Math.ceil(frameCount / OVERVIEW_CURVE_MAX_FRAMES));
  const indexes: number[] = [];
  for (let i = 0; i < frameCount; i += every) {
    indexes.push(i);
  }
  if (every > 1 && indexes[indexes.length - 1] !== frameCount - 1) {
    indexes.push(frameCount - 1);
  }
  return { indexes, every };
}

/** What the website tells the AI about a take when it joins the conversation. */
export async function takeOverview(
  take: Take,
  onStatus?: (line: string) => void,
): Promise<{ text: string; images: OutImage[] }> {
  let d: CloudTake;
  try {
    d = await openCloudTake(take);
  } catch (err) {
    return {
      text: JSON.stringify({ name: take.name, unavailable: (err as Error)?.message ?? 'not in the cloud' }),
      images: [],
    };
  }
  const conditions: Json = {
    camera: d.cameraModel,
    emissivity: d.emissivity,
    recordedAt: recordedAt(d),
    title: d.title,
    description: d.description,
  };
  const sensors = d.sensors;
  const images: OutImage[] = [];

  if (d.kind === 'photo') {
    const n = d.frameCount;
    const out: Json = {
      name: take.name,
      kind: n === 1 ? 'photo' : 'photo set',
      ...(n === 1 ? {} : { photos: n }),
      conditions,
    };
    if (!d.hasData) {
      out.note = 'This picture has no temperature data.';
    } else if (n === 1) {
      const celsius = await d.celsius(0);
      // No whole-frame statistics here: run_code reads them when the AI wants them.
      out.sensors = await Promise.all(
        sensors.map(async (s) => ({
          ...sensorPlace(s),
          ...(s.kind === 'line' ? { maxC: r2(await d.sensorValue(s, 0)) } : { valueC: r2(await d.sensorValue(s, 0)) }),
        })),
      );
      const span = await takeSpan(d);
      images.push({
        mime: 'image/jpeg',
        b64: renderThermalJpeg({
          celsius,
          min: span.min,
          max: span.max,
          title: `${take.name} · thermal`,
          marks: marksOf(d),
        }),
        caption: `${take.name}: thermal`,
        takeId: take.takeId,
      });
      const vis = await d.visible(0);
      if (vis) {
        try {
          images.push({
            mime: 'image/jpeg',
            b64: renderVisibleJpeg(vis, `${take.name} · visible`),
            caption: `${take.name}: visible light`,
            takeId: take.takeId,
          });
        } catch {
          // no visible picture then
        }
      }
    } else {
      // a set: every photo is a frame of its own, read by its number
      out.note = `Each photo is a frame of its own, with no time axis. In look, give a photo by its number (1 to ${n}) in \`times\`; in run_code, photo k is frame index k − 1.`;
      const all = Array.from({ length: n }, (_, i) => i);
      out.sensors = await Promise.all(
        sensors.map(async (s) => ({
          ...sensorPlace(s),
          [s.kind === 'line' ? 'maxCPerPhoto' : 'valueCPerPhoto']: await Promise.all(
            all.map((i) => d.sensorValue(s, i).then(r2, () => null)),
          ),
        })),
      );
      const span = await takeSpan(d);
      // every photo, up to a full set of sheets (MAX_TILES of overviewTiles.ts)
      const moments = all.slice(0, MAX_TILES);
      const thermal: (SheetTile | null)[] = moments.map(() => null);
      const visible: (SheetTile | null)[] = moments.map(() => null);
      await readFrames(d, moments, async (i, celsius) => {
        const label = `photo ${i + 1}`;
        if (celsius) {
          thermal[i] = { kind: 'thermal', celsius, min: span.min, max: span.max, label };
        }
        const vis = await d.visible(i);
        if (vis) {
          visible[i] = { kind: 'visible', image: vis, label };
        }
      });
      const sheets: string[] = [];
      const pushSheets = (
        kind: 'visible light' | 'thermal',
        tiles: SheetTile[],
        scale?: { min: number; max: number },
      ) => {
        const pages = sheetsOf(tiles);
        pages.forEach((page, i) => {
          const part = pages.length > 1 ? ` · sheet ${i + 1} of ${pages.length}` : '';
          images.push({
            mime: 'image/jpeg',
            b64: renderContactSheet(page, `${take.name} · ${kind}${part}`, scale ? { scale } : {}),
            caption: `${take.name}: ${kind}, ${page.length} of ${tiles.length} photos, ${page[0].label} to ${page[page.length - 1].label}${part}`,
            takeId: take.takeId,
          });
        });
        sheets.push(
          `${kind}: ${tiles.length} photos${pages.length > 1 ? ` on ${pages.length} sheets` : ''}, the number under each${
            scale ? `, all on one colour scale (${scale.min} to ${scale.max} °C, shown on the sheet)` : ''
          }`,
        );
      };
      const visTiles = visible.filter((t): t is SheetTile => t != null);
      if (visTiles.length > 0) {
        pushSheets('visible light', visTiles);
      }
      const thTiles = thermal.filter((t): t is SheetTile => t != null);
      if (thTiles.length > 0) {
        pushSheets('thermal', thTiles, span);
      }
      out.visibleLightKept = visTiles.length > 0;
      if (sheets.length > 0) {
        out.overviewSheets = sheets;
      }
    }
    return { text: JSON.stringify(out), images };
  }

  // a recording
  const out: Json = {
    name: take.name,
    kind: d.timelapse ? 'time-lapse recording' : 'recording',
    durationSec: r2(d.spanSec),
    frames: d.frameCount,
    secondsPerFrame: d.timelapse ? d.secondsPerFrame : r3(d.secondsPerFrame),
    ...(d.timelapse && d.timelapseSpec
      ? {
          timelapse: {
            intervalSec: d.timelapseSpec.intervalSec,
            plannedMin: r2((d.timelapseSpec.plannedSec ?? 0) / 60),
            pausedSec: r2(d.timelapseSpec.pausedSec ?? 0),
          },
        }
      : {}),
    conditions,
  };
  const visibleKept = await d.visibleLightKept();
  out.visibleLightKept = visibleKept;
  // the user's sensors, over the whole take (in a stride when the take is long)
  if (sensors.length > 0 && d.hasData) {
    onStatus?.('sensors');
    const { indexes, every } = curveFrames(d.frameCount);
    const rows = await readFrames(d, indexes, async (i, _c, buf) => {
      if (!buf) {
        return sensors.map(() => NaN);
      }
      return Promise.all(sensors.map((s) => d.sensorValue(s, i).catch(() => NaN)));
    });
    out.sensors = sensors.map((s, k) => {
      const pts: SeriesPoint[] = indexes.map((i, r) => ({ t: d.timeOf(i), v: rows[r][k] }));
      const c = compressSeries(pts, { tolerance: 0.1, maxPoints: 60 });
      const sampled = every > 1 ? { sampledEveryNthFrame: every } : {};
      return s.kind === 'line'
        ? {
            ...sensorPlace(s),
            maxAlongLine: { points: c.points, kept: c.kept, of: c.read, ...sampled },
            ...seriesStats(pts),
          }
        : {
            ...sensorPlace(s),
            curve: { points: c.points, kept: c.kept, of: c.read, maxDeviationC: c.maxDeviation, ...sampled },
            ...seriesStats(pts),
          };
    });
  } else {
    out.sensors = [];
  }
  // how the camera behaved
  const camera = await cameraOf(d);
  if (camera) {
    out.camera = camera;
  }
  // Contact sheets of the same moments — as many as the take's length
  // asks for (overviewTiles.ts), paged — one kind in visible light (what was
  // there and what people did, when the take kept it) and one thermal (where
  // it was warm, on one colour scale for the whole take, drawn on each sheet).
  const sheets: string[] = [];
  const moments = tileFrames(d.frameCount, d.spanSec).map((n) => n - 1);
  const timeLabel = (i: number) => `${r2(d.timeOf(i))} s`;
  const pushSheets = (kind: 'visible light' | 'thermal', tiles: SheetTile[], scale?: { min: number; max: number }) => {
    const pages = sheetsOf(tiles);
    pages.forEach((page, i) => {
      const part = pages.length > 1 ? ` · sheet ${i + 1} of ${pages.length}` : '';
      images.push({
        mime: 'image/jpeg',
        b64: renderContactSheet(page, `${take.name} · ${kind} over time${part}`, scale ? { scale } : {}),
        caption: `${take.name}: ${kind}, ${page.length} of ${tiles.length} frames across the take, ${page[0].label} to ${page[page.length - 1].label}${part}`,
        takeId: take.takeId,
      });
    });
    sheets.push(
      `${kind}: ${tiles.length} frames evenly across the take${pages.length > 1 ? ` on ${pages.length} sheets` : ''}, time under each${
        scale ? `, all on one colour scale (${scale.min} to ${scale.max} °C, shown on the sheet)` : ''
      }`,
    );
  };
  onStatus?.('sheets');
  if (visibleKept) {
    try {
      const tiles: SheetTile[] = [];
      const found = await Promise.all(moments.map((i) => d.visible(i)));
      moments.forEach((i, k) => {
        const img = found[k];
        if (img) {
          tiles.push({ kind: 'visible', image: img, label: timeLabel(i) });
        }
      });
      if (tiles.length > 0) {
        pushSheets('visible light', tiles);
      }
    } catch (err) {
      sheets.push(`visible light: not drawn (${(err as Error)?.message ?? err})`);
    }
  }
  if (d.hasData) {
    try {
      const span = await takeSpan(d);
      const tiles: SheetTile[] = [];
      const frames = await readFrames(d, moments, (_i, celsius) => celsius);
      moments.forEach((i, k) => {
        const celsius = frames[k];
        if (celsius) {
          tiles.push({ kind: 'thermal', celsius, min: span.min, max: span.max, label: timeLabel(i) });
        }
      });
      if (tiles.length > 0) {
        pushSheets('thermal', tiles, span);
      }
    } catch (err) {
      sheets.push(`thermal: not drawn (${(err as Error)?.message ?? err})`);
    }
  }
  if (sheets.length > 0) {
    out.overviewSheets = sheets;
  }
  return { text: JSON.stringify(out), images };
}
