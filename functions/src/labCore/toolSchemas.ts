/*
 * The tools the model can use — what each is called, takes and returns, as
 * declared to the model. Server tools run inside the turn (tools.ts); phone
 * tools are declared only when the app says it can run them (labProjectTurn's
 * `phoneTools`), and their calls are handed back to the app, which reads the
 * recording on the phone and returns the result in the next request.
 *
 * Descriptions say what a tool does and returns — not when to use it.
 *
 * Declarations only — no store, no image model, no Firestore: the website's
 * functions copy this file as it is for the analyzer's Ask AI and AI Report
 * (infrared-explorer-web, docs/analyzer-ai-app-flow-plan.md), so what the
 * model is told about a tool is written once. tools.ts re-exports all of it.
 */

import type {ToolSchema} from './llm';

/**
 * The tools that run on the user's device. The model reads temperatures only
 * through code it writes (run_code): measure, chart and place_sensors are no
 * longer declared to it (user decision ㊳, 2026-10-15: with area means to
 * hand — and with place_sensors, areas to name — the model never reached for
 * the whole data), and the code-only mode is the only one (2026-10-26). An
 * app that still offers them, or that predates run_code, gets look and
 * whatever of run_code it has; their calls in older conversations stay in
 * the history as they were.
 */
export const PHONE_TOOLS = ['look', 'run_code'] as const;
export type PhoneToolName = (typeof PHONE_TOOLS)[number];

export function isPhoneTool(name: string): name is PhoneToolName {
  return (PHONE_TOOLS as readonly string[]).includes(name);
}

/** The phone tools the model is given: those of PHONE_TOOLS the app says it can run. */
export function declaredPhoneTools(phoneTools: readonly string[]): PhoneToolName[] {
  return PHONE_TOOLS.filter(n => phoneTools.includes(n));
}

// a suggestion for the report
const REPORT_FIGURES =
  ' A report usually reads best with one sequence of thermal pictures from different moments (an overview sheet, or look with sheet) and one chart; this is a suggestion, not a requirement.';
/**
 * Who reads a lab report and what they expect of it (user decisions ㉟ and
 * ㊽) — a suggestion like REPORT_FIGURES. The reader is named so that the
 * camera's specification and the setup are not retold at length, and the
 * list names the sections once each: the reports written to the earlier
 * list (2026-10-15) retold the camera, listed a take's timeline three times,
 * went over the same numbers in four sections and ended on the numbers
 * again, with the physics left as "a combination of mechanisms". Decision 56
 * (2026-10-15): the reports written to the ㊽ text were still 600–800 words
 * of prose in six sections, each section retelling another, so the reader
 * now has a time and a length, the parts are four, and what the reader
 * skips is listed. The
 * explanation clause says what the reader wants to learn from it — the
 * cause of each thing seen, down to which process moved the heat, why that
 * way, there, at that rate (decision 54, 2026-10-15: the reports written
 * to the ㊽ text still mostly described what was seen). The setup clause
 * says why the reader needs the named places drawn: the reports named t1,
 * t2 throughout with no figure to find them in (decision 55, 2026-10-15;
 * thermalCanvas marks is the way the code draws them). The model reads by
 * code only (decision ㊳), so the readings are spoken of as places read, not
 * as patches it placed. The skip list keeps the
 * camera and its emissivity out of the report as settings, and since
 * decision 60 (2026-10-16) excepts the one sentence on a bare-metal or shiny
 * surface in the experiment: a metal-versus-wood ruler report written to the
 * 56 text said nothing of the metal ruler reading mostly what it reflects.
 * Decision 63 (2026-10-16): the reports written to that text named the
 * principle ("freezing-point depression and latent-heat cooling",
 * "conduction through the bottle wall") and called what was seen
 * consistent with it, without saying how it works; the user wants the
 * principle explained. So the explanation is what the report is read for
 * and has most of its words, a name is said not to be an explanation, one
 * explained principle shows the depth meant, and the skip list's
 * definitions are textbook ones, not how the principle worked here.
 */
const REPORT_EXPECTED =
  ' Readers of a lab report are the person who did the experiment and whoever they share it with. They give it the two minutes before the next thing: half a page of prose, about 300 words, most of them the explanation’s, around one table and two figures, and they stop reading where it says again what a table, a figure or an earlier sentence already said. Four things they expect, in this order. The question and the prediction, with the physics at stake, in two or three sentences (from the plan when there is one). The setup in two or three sentences: what was done when, ' +
  'with what each number was read from, and, since the report calls the places by name — t1, t2, cup, wall — and uses those names in every table, figure and sentence after, one picture of the take with every named place drawn on it and labelled with its name, before the first name is used; a name whose place the reader has not seen drawn on the picture means nothing to them, and coordinates in a list do not show them where it is' +
  '. The results — a table, and figures whose captions are a line naming what each shows, with rates of change or time constants where the data supports them — followed at once by the explanation, which is what they read the report for: the table and figures have told them the what, and here they want the why. ' +
  'The principle at work comes first, explained and not only named: a name — freezing-point depression, conduction, convection — tells them what to call it, not how it works, so it is told as what happens in the matter and to the heat, step by step, until someone who knew only the name sees why things had to go this way (evaporative cooling, explained: the fastest-moving molecules escape the surface and take the heat of evaporation with them, so the water they leave is colder, and it cools until the heat flowing in from the air and the dish matches what leaves). ' +
  'Then each thing seen — where the change is, its shape, how it grows, what stays unchanged — as what that principle predicts, with the cause traced through to what the camera showed — which process moved the heat and through what, such as conduction through a wall, air warmed and rising, water taking its heat of evaporation from the surface it leaves, or radiation from one face to the face opposite, why it went that way and not the other, why here and not there, why at this rate and what sets the rate, such as the mass and heat capacity being warmed, the area in contact or the difference driving it, and why it levels off or stops where it does — a number entering the prose only as the evidence for a cause, and where another mechanism would have made a different picture, what in this picture tells them apart, said once; "a combination of mechanisms" tells them nothing at all' +
  '. And the conclusion, in three or four sentences: whether the prediction held and which principle the experiment therefore demonstrates, the one limit that bears on that conclusion (a camera move or a recalibration mid-take, when there was one), and one thing to try next. What they skip, and so what has no place in it: the textbook definition of a term they know (what radiation or convection is in general, as against how the principle worked here, which is the explanation); the recording’s settings — the camera, its emissivity, its frame rate, how many frames, whether visible light was kept — and the camera’s accuracy figures, and that it sees surfaces and not air — all but one sentence, which they look for when a surface in the experiment is bare metal, or anything else shiny: the camera, at the emissivity set, reads such a surface as mostly what it reflects — a hand, a body, a lamp in front of it — and as colder than it is, so a change read on it is in part the reflection of what moved near it, and a change in the surface itself shows there only in part; said once, where that surface’s numbers are explained, since it decides what those numbers mean; a sentence that reads a row of the table aloud; a number said a second time; a reservation said a second time, or a hedge added after the explanation has said what tells the mechanisms apart; a limit that would be true of any experiment; a next step before the last sentences; and a section with nothing of its own to say. This too is a suggestion, not a requirement.';

/**
 * What the user does with the plan and what they expect of it (user decisions
 * 52 and 54, 2026-10-15) — a suggestion like REPORT_FIGURES. Decision 54 added
 * where it is read (a phone screen) and what is not for it (the camera, the
 * analysis, safety, lists): three plans ran 700–1,100 words, each stating the
 * prediction three times and carrying the camera facts of the system prompt. Each clause answers a
 * plan seen in a salt-and-ice project (p2e05086): the salt added in the setup
 * steps and the baseline asked for in the recording steps after it; "chill
 * the tray and ice in the room" for ice still warming from the freezer; two
 * cubes on one tray, the brine of one reaching the other; cardboard under
 * meltwater; a 10-second time-lapse for a change that is over in a minute;
 * "colder, wetter" for a prediction; and the heat of melting said to come
 * from the surroundings.
 */
const PLAN_EXPECTED =
  ' What the user does with the plan: they read it once here, then follow it from the top with the phone in hand and the plan open in the camera, on a screen that shows a few hundred words at a time, so they expect it to say each thing once, in the order they will do it, and to leave out what they know and what comes later — how their camera behaves and is set, the analysis (yours to do once the captures are in; one line on what will be compared is enough), the handling of hot water or salt, and lists of variables or equipment that the steps already name. They expect: the question and the prediction in a few sentences — for each place that will be read, which way it should go, roughly how far and over what time, what would be seen instead if the prediction were wrong, and the physics behind it as what causes what; the setup, as the drawing and the steps to build it, with the samples left until steady (a sample still warming or cooling from where it was kept is itself a change), the control out of reach of what is done to the test sample (its runoff, its heat, the air it stirs), and surfaces and containers the camera reads well, the same ones for the samples compared; and the recording — which mode, for how long, at what interval, started before the change the experiment is about so that the take holds the steady state first; a change over in minutes as video and a run of an hour as time-lapse, as separate takes when both are wanted. This is a suggestion, not a requirement.';

const SERVER_SCHEMAS: ToolSchema[] = [
  {
    name: 'write_plan',
    description:
      'Write or revise the experiment plan the user follows: a Markdown document whose structure is yours to choose. Pass `markdown` to replace the whole plan, or `edits` (exact find/replace pairs applied in order) to change parts of it. Pictures can be embedded with ![caption](image:ID): the user sees each one where the plan puts it, always as the newest version of that drawing; drawings the plan does not embed are listed after it. The ID is the one draw gave back for the picture, so it exists only once draw has returned: a plan written in the same turn as the draw cannot know it, and any other ID shows the user a missing picture where the plan put it. What comes back is the plan as saved, as the user reads it.' +
      PLAN_EXPECTED,
    parameters: {
      type: 'object',
      properties: {
        markdown: {type: 'string', description: 'The whole plan.'},
        edits: {
          type: 'array',
          description: 'Changes to the current plan; each `find` must match its text exactly.',
          items: {
            type: 'object',
            properties: {find: {type: 'string'}, replace: {type: 'string'}},
            required: ['find', 'replace'],
          },
        },
      },
    },
  },
  {
    name: 'draw',
    description:
      `Make a picture with an image model — for example the schematic of how to set up the experiment. Write the complete description the image model should paint; it sees nothing else of this conversation. To revise a picture pass its id as \`editOf\`; to work from photos or other pictures in this conversation (such as the user’s own bench) pass their ids in \`references\`. The finished picture comes back to you with its id, and the user sees it in the conversation and next to the plan; it has no id until it is back, so a plan that embeds it is written, or edited, after that. How image models behave: they paint a realistic scene unless the description names a style, and a flat schematic — a side or top view in lines and flat colour, few objects, short labels — comes out with the arrangement right more often than a realistic rendering, which places the camera where it likes (one described above the bench and pointing down tends to end up beside it, facing the viewer), adds props of its own (a bare-metal spoon beside the samples) and passes for a photograph of real equipment; asked for a schematic, they still draw each object at a three-quarter angle with perspective and shading unless the description rules those out and says what each thing is in the one view chosen — in a side view a cup is a rectangle with a handle, a sheet facing the cup is a line, a tray is a bar, the phone a small rectangle with the lens drawn on the side that faces the setup, and the ground a line — so that a surface is shown either face-on or edge-on, never both; they do not know the FLIR ONE, a small module clipped to the bottom edge of the phone with its lens facing out, and draw some other camera unless the description says so; an \`editOf\` revision keeps most of the earlier picture, so a different arrangement of the objects often comes out better as a new drawing (it can still pass the old one in \`references\` for its style); they sometimes leave out part of a description or misspell a label, the longer the label the more often; and a graph they paint is only a picture of one — its curve, axis numbers and labels are not plotted from any data.`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {type: 'string', description: 'Everything the image model needs to paint the picture.'},
        caption: {type: 'string', description: 'One line shown under the picture.'},
        editOf: {type: 'string', description: 'Id of the picture this one revises.'},
        references: {type: 'array', items: {type: 'string'}, description: 'Ids of images to work from.'},
        aspect: {type: 'string', enum: ['landscape', 'portrait', 'square']},
      },
      required: ['prompt', 'caption'],
    },
  },
  {
    name: 'set_title',
    description: 'Name the experiment; the name is shown in the user’s experiment list.',
    parameters: {
      type: 'object',
      properties: {title: {type: 'string'}},
      required: ['title'],
    },
  },
  {
    name: 'view',
    description: 'See images from this conversation again by id: pictures you drew, frames looked at earlier, overview sheets of takes.',
    parameters: {
      type: 'object',
      properties: {imageIds: {type: 'array', items: {type: 'string'}}},
      required: ['imageIds'],
    },
  },
  {
    name: 'write_report',
    description:
      'Write or revise the experiment report as a Markdown document whose structure is yours to choose. It is saved with the experiment and shown to the user as its own page. Images from this conversation can be included with ![caption](image:ID).' +
      REPORT_FIGURES +
      REPORT_EXPECTED +
      ' What the page renders: headings, paragraphs, bullet and numbered lists, pipe tables, bold, italic, inline code, fenced code, quotes, links, and mathematics in LaTeX — inline between $…$ or \\(…\\), on lines of its own between $$…$$ or \\[…\\]. HTML is shown as text. Pass `markdown` to replace the whole report, or `edits` (exact find/replace pairs applied in order) to change parts of it — the way to change a report the user has edited, whose wording is theirs. What comes back is the report as saved, with the pictures it embeds, as the user reads it.',
    parameters: {
      type: 'object',
      properties: {
        title: {type: 'string'},
        markdown: {type: 'string', description: 'The whole report.'},
        edits: {
          type: 'array',
          description: 'Changes to the current report; each `find` must match its text exactly.',
          items: {
            type: 'object',
            properties: {find: {type: 'string'}, replace: {type: 'string'}},
            required: ['find', 'replace'],
          },
        },
      },
      required: ['title'],
    },
  },
];

const LOOK_SCHEMA: ToolSchema = {
  name: 'look',
  description: [
    'Look at a take: thermal and/or visible-light pictures at the given moments.',
    'Thermal pictures are rendered from the stored temperature data with one colour scale for the whole take (drawn on the right with its °C labels), so colours compare across times.',
    'A photo take is a single frame at time 0.',
    'With marks, the user’s sensors and temperature lines are drawn on the thermal picture.',
    'With sheet, the moments come back on one picture per kind — a sheet of small frames (240 × 320 each) with the time under each, the way to show a sequence in a report — instead of one full-size picture per moment.',
    'Runs on the user’s device (the phone, or the browser when the user is on the website); the reply lists the frame each picture shows.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      takeId: {type: 'string'},
      times: {type: 'array', items: {type: 'number'}, description: 'Seconds from the start of the take.'},
      kinds: {
        type: 'array',
        items: {type: 'string', enum: ['thermal', 'visible']},
        description: 'Default: both.',
      },
      marks: {type: 'boolean'},
      sheet: {type: 'boolean', description: 'All the moments on one picture per kind; default one picture per moment.'},
    },
    required: ['takeId', 'times'],
  },
};

/**
 * The analysis helpers in run_code's scope (sandboxPage.ts LIBRARY; user
 * decision ㊼). Listed as what each takes and gives, with one example; the
 * example's numbers are a row and a region of no particular take.
 */
const RUN_CODE_HELPERS =
  ' Helpers in scope, for the analysis. A region, wherever one is taken, is [x0, y0, x1, y1] or {x0, y0, x1, y1} in pixels (x to the right, y down from the top; x1 and y1 exclusive), or fractions of the image when all four are within 0 to 1, or a sensor-like {x, y, w, h} (centre and full size as fractions; one of `take.sensors` works as it is); left out, the whole frame. NaN is skipped throughout. Numbers in what is printed or returned are rounded to 0.001. Every helper, with the shape of what it gives, in one example:\n' +
  "const f = await take.celsius(take.frameAt(30));  // the frame at 30 s: Float32Array of 19200 °C, pixel (x, y) at f[y * 120 + x]\n" +
  "const cup = {x0: 0.40, y0: 0.80, x1: 0.60, y1: 0.98};  // a region as fractions; {x: 0.5, y: 0.89, w: 0.2, h: 0.18} (centre and size) is the same one\n" +
  "const a = stats(f, cup);  // {n, min, max, mean, median, p10, p90, sd, hottest: {x, y}, coldest: {x, y}}; stats(f) is the whole frame\n" +
  "const p95 = percentile(f, 95, cup);  // one number; p as a percent or a fraction\n" +
  "const row = rowProfile(f, 100);  // the 120 values along row y = 100 (y = 0 is the top row); rowProfile(f, 100, 30, 90) is x = 30 to 89 of it\n" +
  "const col = colProfile(f, 60, 20, 140);  // the values down column x = 60, y = 20 to 139\n" +
  "const line = lineProfile(f, 0.5, 0.2, 0.5, 0.8);  // [{x, y, value}, …], one a pixel along the line; line.x, line.y, line.value are the same as arrays; lineProfile(f, take.sensors[0]) reads a line sensor\n" +
  "const s = await series(fr => ({cup: stats(fr, cup).mean, top: stats(fr).max}), {every: 1});  // {i: [frame indices], t: [seconds], cup: [...], top: [...]}; fn returning one number gives {i, t, v}; options {take, from, to, every, step} — from, to and every in seconds (from: 8, to: 16, every: 1 is 8 s to 16 s, one a second), step a number of frames; by default every frame of take\n" +
  "const sm = smooth(s.cup, 5);  // centred moving mean over 5 points, same length\n" +
  "const hit = firstTime(s.t, s.cup, 30);  // {t, index} of the first value at or above 30, or null; {below: true} for at or below, {from: 10} to start at 10 s\n" +
  "const lin = fitLine(s.t, s.cup);  // {slope, intercept, r2, n}\n" +
  "const ex = fitExp(s.t, s.cup, {t0: 5});  // y = yInf + (y0 − yInf)·exp(−(t − t0)/tau) → {tau, y0, yInf, t0, rms, n}\n" +
  "const hot = mask(f, 40);  // Uint8Array over the frame, 1 where at or above 40 °C; or mask(f, (v, x, y) => v > 40 && y > 80, region)\n" +
  "const blobs = components(hot, {minPixels: 20, frame: f});  // the mask’s connected regions, largest first: [{n, box: [x0, y0, x1, y1], centroid: {x, y}, max, mean, hottest: {x, y}}, …] (max, mean, hottest only with frame)\n" +
  "print(table(s.t.map((t, k) => ({t, cup: s.cup[k], top: s.top[k]})).filter((r, k) => k % 10 === 0), {digits: 2}));  // rows as objects (or arrays) → an aligned text table; {columns: [...]} picks and orders them\n" +
  "picture(plot({title: 'Cup', x: s.t, xLabel: 'Time (s)', yLabel: '°C', series: {cup: s.cup, smoothed: sm}}), 'Cup region over time');  // series as {name: values} on one x, or [{name, x, y, color}, …]; plot(s, options) draws what series() returned; {xRange, yRange, points: true}\n" +
  "picture(thermalCanvas(f, 20, 70, 3, {grid: 20, marks: [{label: 'cup', region: cup}, take.sensors[0]]}), 'Where each region is');  // the frame in the iron palette, 120 × 160 at scale 1, from 20 to 70 °C (without them, the frame’s own range); pixel ticks every 20; each mark (any region form, a sensor as it is, or a line) outlined and labelled\n" +
  '(A run costs a few seconds, so printing what a helper gives before building on it is cheap.) The marks picture is the one that shows a reader where each place a name stands for was read, and the one that shows you whether each region sits on the thing it is meant to read: a region placed from a visible-light picture sits beside the thing on the thermal grid, and what a region covers also shows in its numbers (a cup region whose mean is 46 °C while its max is 70 °C is half background), so a picture of the regions drawn on one frame, looked at before a take is read through them, is the cheapest check there is.';

const PHONE_SCHEMAS: Record<PhoneToolName, ToolSchema> = {
  look: LOOK_SCHEMA,
  run_code: {
    name: 'run_code',
    description:
      'Run JavaScript you write on the user’s device (the phone, or the browser when the user is on the website), over the stored temperature data of one or more takes, and get back what it printed, what it returned and the pictures it drew — your own analysis, in code, of the full data. The code is the body of an async function (`await` is allowed; `return` ends it with a value, which comes back as JSON). In scope: `take` (the first take named) and `takes` (all of them, in the order named), each with `id`, `name`, `kind`, `frameCount`, `width` (120), `height` (160), `times` (seconds of each frame from the start; in code frames are indexed from 0), `secondsPerFrame`, `emissivity`, `sensors` (the take’s sensors and temperature lines: `name`, `type` point/rect/ellipse with `x`, `y` the centre and `w`, `h` full sizes, or line with `x1`, `y1`, `x2`, `y2`; fractions of the image), `camera` (`movedDuring` as [from, to] seconds, `shutterCalibrationsAt` seconds), `visibleLightKept`, `frameAt(seconds)` → index, `timeOf(index)` → seconds, `await take.celsius(i)` → a Float32Array of 19200 °C values, row-major, pixel (x, y) at index y * 120 + x, NaN where unreadable — the stored data, the same numbers the app’s player shows — `await take.celsiusRange(from, to)` → an array of those frames, from..to inclusive, and `await take.visible(i)` → an Image of the visible-light frame to draw on a canvas (null when the take has none). Also in scope: `print(...values)` (text that comes back to you, up to 20,000 characters, kept even if the code fails later), `picture(canvas, caption)` (a canvas comes back to you as a picture and is shown to the user; like any picture here it can go in the plan or the report with ![caption](image:ID); up to 8 per run, longest edge 1600 px), `thermalCanvas(celsius, minC, maxC, scale = 1)` (a canvas of a frame in the app’s iron palette, 120 × 160 at scale 1, to draw on; without minC and maxC the frame’s own range) and `document.createElement(\'canvas\')` with its 2D context for charts and drawings. `save(name, value)` keeps a JSON-serialisable value with the experiment for later runs (an array of numbers, a position found, a table), `load(name)` brings it back (null when there is none), `save(name, null)` drops it; the names and sizes of the saved values come back with every run, and they may hold 4 MB in all.' +
      RUN_CODE_HELPERS +
      ' The page has no network. An error comes back with its message and what was printed and saved before it. Between runs only the saved values and the pictures already sent are kept: variables and functions are not. Reading frames is what takes the time: on the phone about 50 ms a frame, so a 20-minute recording (6,000 frames at 5 a second) is 5 minutes read whole; in the browser the frames come over the network, slower than that the first time and fast once cached. A run still going after 10 minutes is stopped and comes back with how many frames it had read. Frames read in a stride (`every`, `step`, or a loop at one stride) cost only the frames landed on.',
    parameters: {
      type: 'object',
      properties: {
        takeIds: {type: 'array', items: {type: 'string'}, description: 'The takes the code works on, 1 to 4; `take` is the first.'},
        code: {type: 'string', description: 'The body of the async function.'},
        purpose: {type: 'string', description: 'One line shown to the user, saying what the code does.'},
      },
      required: ['takeIds', 'code'],
    },
  },
};

export interface ToolSchemaOptions {
  /**
   * The server tools to declare, by name; left out, all of them. The
   * website's analyzer, where there is no plan to write, no picture to draw
   * and no title to set, declares view and write_report alone.
   */
  serverTools?: readonly string[];
}

/**
 * The tools the model is given: the server's (or those named in
 * `serverTools`), and the phone tools in `phoneTools` (already reduced to
 * what the model gets, declaredPhoneTools).
 */
export function toolSchemas(phoneTools: readonly string[], opts: ToolSchemaOptions = {}): ToolSchema[] {
  const server = SERVER_SCHEMAS.filter(s => opts.serverTools == null || opts.serverTools.includes(s.name));
  const phone = PHONE_TOOLS.filter(n => phoneTools.includes(n)).map(n => PHONE_SCHEMAS[n]);
  return [...server, ...phone];
}

const SCHEMA_OF = new Map<string, ToolSchema>(
  [...SERVER_SCHEMAS, ...Object.values(PHONE_SCHEMAS)].map(s => [s.name, s]),
);

/** A value in the type its schema declares: "3.2" where a number belongs is 3.2, "true" a boolean. */
function asDeclared(value: unknown, schema: unknown): unknown {
  const s = (schema ?? {}) as {type?: unknown; items?: unknown; properties?: Record<string, unknown>};
  switch (s.type) {
    case 'number': {
      const n = typeof value === 'string' && value.trim() ? Number(value) : NaN;
      return Number.isFinite(n) ? n : value;
    }
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value;
    case 'array':
      return Array.isArray(value) ? value.map(v => asDeclared(v, s.items)) : value;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = asDeclared(v, s.properties?.[k]);
      }
      return out;
    }
    default:
      return value;
  }
}

/**
 * A tool call's arguments with every value in the type the tool's schema
 * declares. Models do not all keep to a schema: Gemini sometimes writes the
 * numbers of an array as strings (`"times": ["1", "50", "100"]`; in other
 * calls plain numbers), which a tool that expects numbers reads as no times
 * at all. Arguments that already fit, or
 * are not JSON, come back as the model wrote them.
 */
export function normalizeToolArgs(name: string, rawArgs: string): string {
  const schema = SCHEMA_OF.get(name);
  if (!schema) {
    return rawArgs;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs || '{}');
  } catch {
    return rawArgs;
  }
  const fixed = JSON.stringify(asDeclared(parsed, schema.parameters));
  return fixed === JSON.stringify(parsed) ? rawArgs : fixed;
}

/** The ids of the pictures a Markdown document embeds with ![caption](image:ID), in order, each once. */
export function reportImageIds(markdown: string): string[] {
  const ids: string[] = [];
  const re = /!\[[^\]]*\]\(\s*image:([A-Za-z0-9_-]+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    if (!ids.includes(m[1])) {
      ids.push(m[1]);
    }
  }
  return ids;
}
