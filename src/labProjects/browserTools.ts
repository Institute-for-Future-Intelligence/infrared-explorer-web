/*
 * The tools the AI runs in the browser — look, and run_code (its own code
 * over the data, in the sandbox of sandboxHost.ts) — over the cloud copies
 * of the project's captures (cloudTake.ts). The website's version of the
 * app's lib/labProjects/phoneTools.ts `look` and runCode.ts: the same
 * arguments, the same reply shapes, the same pictures, read from the cloud
 * instead of the phone's files. measure, chart and place_sensors are not
 * here: with the server's temperatures-by-code-only setting the model gets
 * look and run_code alone (functions/src/tools.ts declaredPhoneTools), and
 * BROWSER_TOOLS is what the website declares with every turn.
 *
 * A take with no copy in the cloud (captured on the phone and not uploaded)
 * answers `ok: false` with PHONE_ONLY_TEXT: the model is told where the
 * capture is, and nothing is made up.
 */

import { firebaseAuth } from '../services/firebase';
import { readCodeState, writeCodeState, type CodeState } from './codeState';
import { FRAMES_PER_CHUNK, PRINT_LIMIT, encodeFrames, type SandboxSensor, type TakeMeta } from './core/sandboxPage';
import type { OutImage, PendingCall, PhoneToolResult, Take } from './core/types';
import { PHONE_ONLY_TEXT, TakeUnavailable, marksOf, openCloudTake, takeSpan, type CloudTake } from './cloudTake';
import { cameraOf } from './overview';
import { renderContactSheet, renderThermalJpeg, renderVisibleJpeg, type SheetTile } from './render';
import { runInSandbox } from './sandboxHost';
import { IR_ARRAY_HEIGHT, IR_ARRAY_WIDTH } from './recordingFormat';

/** The client tools this website can run — sent with every turn (the app sends core/types PHONE_TOOLS). */
export const BROWSER_TOOLS = ['look', 'run_code'] as const;

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const yieldJs = () => new Promise<void>((res) => setTimeout(res, 0));

type Json = Record<string, unknown>;

function ok(callId: string, payload: Json, images: OutImage[] = []): PhoneToolResult {
  return { callId, ok: true, text: JSON.stringify(payload), images };
}

function fail(callId: string, message: string): PhoneToolResult {
  return { callId, ok: false, text: message };
}

function parseArgs(raw: string): Json {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Json) : {};
  } catch {
    return {};
  }
}

// A numeric string counts: Gemini sometimes writes the numbers of an array as
// strings ("times": ["1", "50", "100"]).
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function takeFor(takes: Take[], args: Json): Take | null {
  const id = str(args.takeId);
  return takes.find((t) => t.takeId === id) ?? null;
}

/** When a frame is, in the words the pictures carry. */
function whenOf(d: CloudTake, i: number): string {
  if (d.kind === 'photo') {
    return d.frameCount > 1 ? `photo ${i + 1} of ${d.frameCount}` : 'photo';
  }
  return `t = ${r2(d.timeOf(i))} s (frame ${i + 1} of ${d.frameCount})`;
}

// ------------------------------------------------------------------- look

const MAX_LOOK_TIMES = 12;

async function look(call: PendingCall, takes: Take[]): Promise<PhoneToolResult> {
  const args = parseArgs(call.args);
  const take = takeFor(takes, args);
  if (!take) {
    return fail(call.id, `There is no take ${str(args.takeId)} in this experiment.`);
  }
  const d = await openCloudTake(take);
  const kinds = Array.isArray(args.kinds) && args.kinds.length > 0 ? args.kinds.map(str) : ['thermal', 'visible'];
  const wantThermal = kinds.includes('thermal');
  const wantVisible = kinds.includes('visible');
  const askedTimes = Array.isArray(args.times) ? args.times : [];
  const rawTimes = askedTimes.map(num).filter((t): t is number => t != null);
  if (askedTimes.length > 0 && rawTimes.length === 0) {
    // drawing the first frame instead would look like an answer to another question
    return fail(
      call.id,
      'None of `times` is a number. Give each as seconds from the start of the take, for example [0, 12.5, 60].',
    );
  }
  const times = (rawTimes.length > 0 ? rawTimes : [0]).slice(0, MAX_LOOK_TIMES);
  const span = wantThermal && d.hasData ? await takeSpan(d) : null;
  const marks = wantThermal && (args.marks === true || args.marks === 'true') ? marksOf(d) : undefined;
  // all the moments on one picture per kind (a sequence for a report), or a full-size picture each
  const asSheet = args.sheet === true || args.sheet === 'true';
  const images: OutImage[] = [];
  const rows: Json[] = [];
  const thermalTiles: SheetTile[] = [];
  const visibleTiles: SheetTile[] = [];
  let thermalDrawn = false;
  for (const t of times) {
    const i = d.frameAt(t);
    const at = r2(d.timeOf(i));
    const when = whenOf(d, i);
    // a sheet tile's label: the moment, or the photo's number in a set
    const label = d.kind === 'photo' && d.frameCount > 1 ? `photo ${i + 1}` : `${at} s`;
    const row: Json = { asked: t, frame: i + 1, time: at };
    if (wantThermal) {
      if (d.hasData && span) {
        try {
          const celsius = await d.celsius(i);
          if (asSheet) {
            thermalTiles.push({ kind: 'thermal', celsius, min: span.min, max: span.max, label });
            row.thermal = 'on the thermal sheet';
          } else {
            images.push({
              mime: 'image/jpeg',
              b64: renderThermalJpeg({
                celsius,
                min: span.min,
                max: span.max,
                title: `${take.name} · thermal · ${when}`,
                marks,
              }),
              caption: `${take.name}: thermal, ${when}`,
              takeId: take.takeId,
            });
            row.thermal = `picture ${images.length}`;
          }
          thermalDrawn = true;
        } catch (err) {
          row.thermal = `unreadable (${(err as Error)?.message ?? err})`;
        }
      } else {
        row.thermal = 'this take has no temperature data';
      }
    }
    if (wantVisible) {
      const img = await d.visible(i);
      if (img) {
        try {
          if (asSheet) {
            visibleTiles.push({ kind: 'visible', image: img, label });
            row.visible = 'on the visible-light sheet';
          } else {
            images.push({
              mime: 'image/jpeg',
              b64: renderVisibleJpeg(img, `${take.name} · visible · ${when}`),
              caption: `${take.name}: visible light, ${when}`,
              takeId: take.takeId,
            });
            row.visible = `picture ${images.length}`;
          }
        } catch {
          row.visible = 'unreadable';
        }
      } else {
        row.visible = 'not kept for this take';
      }
    }
    rows.push(row);
    await yieldJs();
  }
  // the sheets, one per kind, with every moment's time under its frame
  const sheetOf = (kind: 'thermal' | 'visible light', tiles: SheetTile[], scale?: { min: number; max: number }) => {
    images.push({
      mime: 'image/jpeg',
      b64: renderContactSheet(tiles, `${take.name} · ${kind} · ${tiles.length} moments`, scale ? { scale } : {}),
      caption: `${take.name}: ${kind}, ${tiles.length} moments on one sheet: ${tiles.map((t) => t.label).join(', ')}`,
      takeId: take.takeId,
    });
    return `picture ${images.length}`;
  };
  const sheets: Json = {};
  if (thermalTiles.length > 0 && span) {
    sheets.thermalSheet = sheetOf('thermal', thermalTiles, span);
  }
  if (visibleTiles.length > 0) {
    sheets.visibleSheet = sheetOf('visible light', visibleTiles);
  }
  const notes: string[] = [];
  if (rawTimes.length > MAX_LOOK_TIMES) {
    notes.push(`Only the first ${MAX_LOOK_TIMES} times were drawn.`);
  }
  if (asSheet && marks) {
    notes.push('Marks are drawn on full-size pictures, not on a sheet.');
  }
  return ok(
    call.id,
    {
      takeId: take.takeId,
      frames: rows,
      ...sheets,
      // the scale belongs to the thermal pictures: none drawn, none described
      ...(wantThermal
        ? {
            thermalScale:
              thermalDrawn && span
                ? { minC: span.min, maxC: span.max, palette: 'iron (dark = cold, white = hot)' }
                : null,
          }
        : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    },
    images,
  );
}

// --------------------------------------------------------------- run_code

const MAX_TAKES = 4;
/** A picture past this (base64) is left out: the server takes 6 MB, and the model's context is paid per picture. */
const MAX_PICTURE_B64 = 2 * 1024 * 1024;

/** The takes named, in the order named: `takeIds`, or a single `takeId`. */
function namedTakes(args: Json): string[] {
  const list = Array.isArray(args.takeIds) ? args.takeIds.map(str).filter(Boolean) : [];
  const one = str(args.takeId);
  if (one && !list.includes(one)) {
    list.unshift(one);
  }
  return [...new Set(list)];
}

function sandboxSensors(d: CloudTake): SandboxSensor[] {
  return d.sensors.map((s) =>
    s.kind === 'line'
      ? { name: s.label, type: 'line' as const, x1: r3(s.x1!), y1: r3(s.y1!), x2: r3(s.x2!), y2: r3(s.y2!) }
      : s.area && s.area.kind !== 'point'
        ? { name: s.label, type: s.area.kind, x: r3(s.x!), y: r3(s.y!), w: r3(s.area.w), h: r3(s.area.h) }
        : { name: s.label, type: 'point' as const, x: r3(s.x!), y: r3(s.y!) },
  );
}

/** What the page is told of a take (sandboxPage.TakeMeta). */
async function takeMeta(take: Take, d: CloudTake): Promise<TakeMeta> {
  const times: number[] = [];
  for (let i = 0; i < d.frameCount; i++) {
    times.push(r3(d.timeOf(i)));
  }
  return {
    id: take.takeId,
    name: take.name,
    kind: d.kind === 'photo' ? 'photo' : d.timelapse ? 'time-lapse recording' : 'recording',
    frameCount: d.frameCount,
    width: IR_ARRAY_WIDTH,
    height: IR_ARRAY_HEIGHT,
    times,
    secondsPerFrame: d.kind === 'photo' ? 0 : r3(d.secondsPerFrame),
    emissivity: d.emissivity,
    sensors: sandboxSensors(d),
    camera: await cameraOf(d),
    visibleLightKept: await d.visibleLightKept(),
  };
}

async function runCode(call: PendingCall, takes: Take[], projectId: string): Promise<PhoneToolResult> {
  const args = parseArgs(call.args);
  const code = str(args.code);
  if (!code.trim()) {
    return fail(call.id, 'There is no code to run (`code` is empty).');
  }
  const ids = namedTakes(args);
  if (ids.length === 0) {
    return fail(call.id, 'Name the takes the code works on (`takeIds`).');
  }
  // the takes the code gets, in the order named; the others are explained
  const opened: { take: Take; d: CloudTake }[] = [];
  const notes: string[] = [];
  for (const id of ids.slice(0, MAX_TAKES)) {
    const take = takes.find((t) => t.takeId === id);
    if (!take) {
      notes.push(`There is no take ${id} in this experiment.`);
      continue;
    }
    try {
      const d = await openCloudTake(take);
      if (!d.hasData) {
        notes.push(`"${take.name}" has no temperature data, so the code did not get it.`);
      } else {
        opened.push({ take, d });
      }
    } catch (err) {
      notes.push(
        err instanceof TakeUnavailable
          ? err.message
          : `"${take.name}" could not be opened: ${(err as Error)?.message ?? err}`,
      );
    }
  }
  if (ids.length > MAX_TAKES) {
    notes.push(`Only the first ${MAX_TAKES} takes were given to the code.`);
  }
  if (opened.length === 0) {
    return fail(call.id, notes.join(' '));
  }
  const metas: TakeMeta[] = [];
  for (const o of opened) {
    metas.push(await takeMeta(o.take, o.d));
  }

  let printed = '';
  const pictures: { index: number; caption: string; png: string }[] = [];
  // what earlier runs saved goes in; what this one saves comes out, kept even when the run then fails
  const uid = firebaseAuth.currentUser?.uid ?? '';
  const before = await readCodeState(uid, projectId);
  const saved: CodeState = { ...before };
  let savedChanged = false;
  const outcome = await runInSandbox({
    code,
    takes: metas,
    saved: before,
    onSave: (name, json) => {
      savedChanged = true;
      if (json == null) {
        delete saved[name];
      } else {
        saved[name] = json;
      }
    },
    loadFrames: async (t, from, to, step, deliver) => {
      const d = opened[t]?.d;
      if (!d) {
        throw new Error(`There is no take ${t}.`);
      }
      // the page's walk in strides asks for every `by`-th frame only: the
      // frames between are never read
      const by = Math.max(1, Math.round(step) || 1);
      const last = Math.min(d.frameCount - 1, Math.max(from, to));
      for (let start = Math.max(0, Math.min(from, to)); start <= last; start += FRAMES_PER_CHUNK * by) {
        const end = Math.min(last, start + (FRAMES_PER_CHUNK - 1) * by);
        const wanted: number[] = [];
        for (let i = start; i <= end; i += by) {
          wanted.push(i);
        }
        // a chunk's frames come down together (cloudTake.ts keeps 8 requests in flight)
        const raws = await Promise.all(wanted.map((i) => d.inflated(i).catch(() => null)));
        const missing: number[] = [];
        raws.forEach((r, k) => {
          if (!r) {
            missing.push(k);
          }
        });
        deliver(start, encodeFrames(raws), missing);
        await yieldJs();
      }
    },
    loadVisible: async (t, i) => {
      const d = opened[t]?.d;
      if (!d) {
        return null;
      }
      return d.visibleDataUrl(i);
    },
    onPrint: (s) => {
      if (printed.length < PRINT_LIMIT + 200) {
        printed += s;
      }
    },
    onPicture: (p) => {
      pictures.push(p);
    },
  });

  if (savedChanged) {
    await writeCodeState(uid, projectId, saved);
  }
  const savedSizes: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved)) {
    savedSizes[k] = v.length;
  }

  const images: OutImage[] = [];
  const listed: Json[] = [];
  for (const p of pictures) {
    if (p.png.length > MAX_PICTURE_B64) {
      notes.push(`Picture ${p.index} was too large to send (over 2 MB as PNG) and was left out.`);
      continue;
    }
    images.push({
      mime: 'image/png',
      b64: p.png,
      caption: p.caption || `Picture ${p.index} from the code`,
      ...(opened.length === 1 ? { takeId: opened[0].take.takeId } : {}),
    });
    listed.push({ picture: `picture ${images.length}`, caption: p.caption || null });
  }
  let returned: unknown = null;
  if (outcome.returned != null) {
    try {
      returned = JSON.parse(outcome.returned);
    } catch {
      returned = outcome.returned;
    }
  }
  const text: Json = {
    takeIds: opened.map((o) => o.take.takeId),
    ...(str(args.purpose).trim() ? { purpose: str(args.purpose).trim() } : {}),
    ran: { ms: outcome.ms, framesRead: outcome.framesRead },
    printed: printed || '',
    returned,
    ...(listed.length > 0 ? { pictures: listed } : {}),
    ...(Object.keys(savedSizes).length > 0 ? { saved: savedSizes } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
  return { callId: call.id, ok: outcome.ok, text: JSON.stringify(text), images };
}

// --------------------------------------------------------------- dispatch

/** The browser can run this call (the tool exists here). What the call reads may still be out of reach. */
export const browserCanRun = (name: string): boolean => (BROWSER_TOOLS as readonly string[]).includes(name);

/** Run a tool the AI asked for. */
export async function runBrowserTool(call: PendingCall, takes: Take[], projectId: string): Promise<PhoneToolResult> {
  // Only captures already sent to the AI: one still waiting beside the
  // message box is not opened for it.
  const sent = takes.filter((t) => t.announced);
  try {
    switch (call.name) {
      case 'look':
        return await look(call, sent);
      case 'run_code':
        // the model's own code over the stored temperatures, in the sandbox (sandboxHost.ts)
        return await runCode(call, sent, projectId);
      default:
        // a call the app left (measure, chart, place_sensors): those tools run on the phone only
        return fail(
          call.id,
          `The user is on the website now, where ${call.name} is not available; it runs in the app. look and run_code work here.`,
        );
    }
  } catch (err) {
    if (err instanceof TakeUnavailable) {
      return fail(call.id, err.message);
    }
    return fail(call.id, `${call.name} failed in the browser: ${(err as Error)?.message ?? err}`);
  }
}

export { PHONE_ONLY_TEXT };
