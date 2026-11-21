# Time-lapse experiments (2026-09-28)

The capture app records **time-lapse** takes: one thermal frame every `interval` (1 s … 10 min, default
60 s) for up to 24 h. The frames are uploaded exactly like an ordinary recording
(`recordings/{recordingId}/data_N.dat`, `data_N.png`, `vis_N.jpg`, `mix_N.jpg`, N = 1..frameCount), so
every frame reader serves them unchanged. What changes is the **time axis**: a frame index is minutes or
hours of recording time, not a fifth of a second. Design on the app side:
`infrared-explorer-app/docs/proposals/time-lapse-recording.md` (§2 #10, §3.4, §4 WP-D).

(A third kind of time base came in 2026-11 — the **camera-timed** recording, whose frames are unevenly
spaced and whose infrared picture is painted from the temperatures. It is the last part of this file,
"Camera-timed recordings"; what follows here describes the two grids, which are unchanged.)

## The rule: pacing vs time axis

- **Playback pacing stays 5 fps** (`FPS` in `src/utils/constants.ts` / `functions/src/thermal.ts`): a
  time-lapse plays as a sped-up film — a 24 h take of 1441 frames plays in 4 min 48 s. `FPS` is kept only
  where it means pacing — the player's tick interval and preload reach, the 3D surface's play loop — and
  for the control bar's film clock (below).
- **Every frame → time conversion goes through `src/utils/frameTime.ts`.** Nothing else may write
  `/ FPS`, `* 5` or `1 / FPS` for a time.

## The doc contract (`experiments/{id}`, sourceType `recording`)

New optional fields, written by the app:

| field | meaning |
| --- | --- |
| `timelapse: { intervalSec, plannedSec?, pausedSec?, pauses? }` | Present (`intervalSec > 0`) ⇒ this is a time-lapse. Frame N (1-based; player index N−1) was taken at (N−1) × intervalSec seconds of **recording** time. Pauses are already excluded from that grid, so the axis is uniform. `pausedSec` is the total the take stood still; `pauses` (uploads since 2026-11) lists each pause as `{startSec, endSec}` in real seconds since `startedAt`, in order, `startSec < endSec` — written only when the take was paused. |
| `frameCount` | Frames uploaded (`data_1 … data_frameCount`). Present on time-lapse docs (may appear on ordinary recordings later). Absent ⇒ derived as `round(duration × 5)`. |
| `duration` | **Always seconds of recording time.** Time-lapse: the real span, `round((frameCount − 1) × intervalSec)`, at least 1. Ordinary recording: unchanged (frames / 5). When both `duration` and `frameCount` are present, neither is derived from the other. |
| `startedAt` | Epoch ms the take started. Display only (the capture-time overlay). Since 2026-10 the app writes it on **every** recording, not only time-lapses — the owner's cards date an experiment by it (`src/utils/captureTime.ts`); its presence does not mark a time-lapse, `timelapse` does. |
| `complete` | `false` when the take ended before its planned end. Still fully playable; display only ("· incomplete"). |

Firestore / Storage rules already accept these fields. **Photo sets (`sourceType 'photos'`) are untouched**:
they have no time axis and none of this applies to them.

## `src/utils/frameTime.ts`

Pure, unit-tested (`frameTime.test.ts`):

- `isTimelapse(exp)` — a positive `timelapse.intervalSec` on the doc.
- `secondsPerFrame(exp)` — the interval for a time-lapse, else `1 / FPS`.
- `lastFrameIndexOf(exp)` — `frameCount − 1` when the doc carries a count (≥ 1), else
  `round(duration × FPS) − 1`; never below 0. A trimmed clip's own last index still comes from its
  segments (`useMappingIndex`).
- `frameTimeSec(exp, playerIndex)` — recording seconds of a player index.
- The elapsed-time axis (the T(t) chart on a time-lapse's `recording` and `film` clocks, below):
  `elapsedTicksSec(spanSec, stepSec)` — the round elapsed times from 0 across the span, at
  `clockTickStepSec`'s step, each written with `formatTransportTime` so a tick and the readout agree to
  the letter; `elapsedAxisLabel(clock, spanSec)` — `Elapsed time (mm:ss)` / `Film time (h:mm:ss)`, the
  hours field from an hour on.
- `formatIntervalSec(sec)` — "1 s" / "2.5 min" / "1 h" for the Info tab and the card tooltip.
- `pausedBeforeSec(pauses, recordingSec)` — the wall-clock time the take's pauses add to a frame at that
  recording-time slot: the lengths of every pause that began before it (pause i began at recording time
  `startSec_i − lengths of the pauses before it`; a slot at or before that instant was taken before the
  pause). `frameCaptureTimeMs(exp, recordingFrame)` — `startedAt` + grid + that; null for an ordinary
  recording or a doc without `startedAt`. `captureTimeIsExact(exp)` — false only for a paused take whose
  doc carries `pausedSec` but no `pauses` (an older upload).
- The time-of-day axis (the T(t) chart on the `capture` clock, below): `clockTickStepSec(spanSec)` — the
  round wall-clock step that ticks a span about eight times (95 min → 15 min, 24 h → 3 h);
  `clockTicksMs(startMs, endMs, stepSec)` — the round local clock times in the span, each day counted from
  its own midnight (daylight-saving safe); `formatClockTick(ms, stepSec)` — `14:15`, `14:15:30` under a
  minute apart; `clockAxisLabel(startMs, endMs)` — `Time of day (Sep 28, 2026)`, both dates across
  midnight; `playerTimeAtCaptureMs(captureTimeOf, lastIndex, secondsPerFrame, ms)` — where an instant
  falls on a player-time axis, proportionally between the two frames around it.

`utils/helpers.ts formatDuration` now renders `h:mm:ss` from an hour up (`m:ss` below, as before).

## What changed (web)

Client — every time use of `1/FPS`, `* 5` or the duplicate `RECORDING_FPS` now reads the helpers:

- `useMappingIndex(segments, experiment)` takes the experiment (was `duration`) and uses `lastFrameIndexOf`.
- `imagePlayer`: one `spf = secondsPerFrame(experiment)` feeds the capture-time overlay, key-moment / Q&A
  instants (`tSeconds`), the T(t) rows
  (`LineplotData.secondPerFrame`), the published `playerFrameRate`, the Δ-view reference label,
  annotation windows, the Lab Assistant's seek / playhead and the 3D surface's clock labels
  (`ThermalSurface3D` gained an optional `secondsPerFrame`; its `fps` stays the play pacing).
- `linePlot` keeps its rows in recording seconds (playhead, click-to-seek, fit window and CSV unchanged);
  an ordinary recording's axis is the plain seconds it always was, and a time-lapse's counts in the
  control bar's clock, its ticks written as the readout writes them (`Playback clock and capture time`,
  below; the time of day through `LineplotData.captureTimeOf`).
- `keyMoments.parseTime` accepts `h:mm:ss` as well as `mm:ss`; `aiReport` resolves figure instants with
  `secondsPerFrame(experiment)`; `twinPanel` counts frames with `lastFrameIndexOf`.
- Cards: the duration pill reads `Time-lapse · 24:00:00` (tooltip: the interval); the Info tab's facts strip
  gains a "Time-lapse" cell (`every 1 min · plays 300× real time`, with an "Incomplete" flag when the take
  stopped short of its plan).
- `services/experiments.ts`: `cloneExperimentById` / `cloneExperiment` carry `timelapse`, `frameCount`,
  `startedAt`, `complete` (`timelapseFields`). A clip of a time-lapse keeps the parent's semantics —
  segments are recording-frame indices, so the clip's span follows from them and `duration` stays the
  parent's, as it already does for every clip. `recordHistory` snapshots `timelapse` so the Recent card
  says so. The Lab Assistant's app-state context and search results carry `timelapseIntervalSec`.

Functions:

- `recordingSampling(segments, duration, limit, { frameCount?, secondPerFrame? })` — the defaults
  reproduce the 5 fps grid exactly; `recordingTiming(doc)` / `timelapseIntervalSec(doc)` read a doc.
- `buildThermalSummary` samples real frames stamped with real seconds; the summary sent to the model says
  `timelapse: { intervalSec }` + `secondsPerFrame` for a time-lapse (and `fps: 5` only for an ordinary
  recording). The report, Q&A and Lab Assistant prompts each carry one sentence: a time-lapse's `times`
  are real seconds that may span hours — cite them as h:mm:ss or minutes, never frame counts; a report's
  figure marker still names its instant in seconds (`[figure: t = 4800 s | …]`, what the client parses).
- The deep report's `sample_frames` tool and the recording `FrameLocator` divide a requested instant by
  `secondPerFrame` instead of multiplying by `FPS`. The orbit-twin path just passes the timing through.

## Playback clock and capture time

The control bar opens on the take's REAL clock: its readout, scrub preview and slider tooltips go by the
recording's real elapsed time (`formatTransportTime` of index × interval — a 1441-frame take a minute
apart reads `00:00/24:00:00`). On a time-lapse the readout is a button that **switches the bar's clock**
(`TransportClock` in `utils/frameTime`; the choice is this browser's, `viewerPrefs transportClock`, not
the experiment's): real elapsed time → when `startedAt` is known, each frame's **time of day**
(`14:10:15`, the same `frameCaptureTimeMs` as the overlay below, through the clip mapping) → the
**film's own time** (frames at 5 fps — that take reads `00:00/04:48` — on which scrubbing a 24 h take
feels like any other clip) → real. A small tag on the readout names the clock (`REAL` / `CLOCK` /
`FILM`); the readout's tooltip says what the next click gives, and on the time of day the shown frame's
date. An ordinary recording has only the one clock (its film time is its real time) and its readout stays
plain text. The frames' real times also live elsewhere:

- The toolbar's clock button — shown only for a time-lapse whose document carries `startedAt` — overlays
  the shown frame's **capture time** (`Sep 28, 2026 14:10:15`) at the bottom-left of the frame
  (`ExperimentGraphOption.captureTime`, saved with the other overlay toggles; it moves to the bottom-right
  while the Δ view's legend owns the bottom-left). The time is `frameCaptureTimeMs`: `startedAt` + the
  frame's grid slot + the pauses that preceded it (`timelapse.pauses`), so a paused take reads to the
  frame like a never-paused one (the app's `frameCaptureMs` is the same answer measured rather than
  derived — the two agree to within one stream frame). An older upload that was paused carries only
  `pausedSec`: still shown, with no visible marker (the pill's tooltip says it is approximate and by how
  much — a frame after a pause was really taken up to `pausedSec` later than `startedAt + grid` says). The
  time is computed on the RECORDING frame (`getRecordingIndex`), so a trimmed clip of a take reads right.
- The **T(t) chart's axis counts in the transport clock** (the choice lives in the store,
  `transportClock`, backed by `viewerPrefs`), its ticks written as the readout writes them so the two
  agree to the letter. On the real clock: round steps (`clockTickStepSec` — 15 min, 30 min, 1 h …) in
  `mm:ss` / `h:mm:ss` (`30:00`, `1:00:00`), titled `Elapsed time (h:mm:ss)`. On the film clock: the same
  in film seconds (`00:30`, `01:00`), titled `Film time (mm:ss)`. On the time of day: ticks at round
  wall-clock times (`14:00`, `14:15`, …; `HH:mm:ss` under a minute apart) in the viewer's time zone,
  titled `Time of day (Sep 28, 2026)` (both dates when the take crosses midnight), each placed where its
  instant falls between the two frames around it (`playerTimeAtCaptureMs`), so a tick inside a pause or a
  clip cut sits proportionally in the gap the line crosses. The hover column's chip on the axis reads the
  same clock. The rows keep recording seconds — the playhead, click-to-seek, the fit window and the CSV
  are untouched. An ordinary recording's axis stays the plain seconds it always was (`Time (Second)`; its
  one clock counts the same). Key moments, annotation windows and the report's instants stay in recording
  seconds (`frameTimeSec`), hours apart for a long take.
- The Info tab's time-lapse row states the **speed**: `every 1 min · plays 300× real time`
  (`playbackSpeedFactor` = interval × 5 fps), then how long the take stood still when it was paused
  (`· paused 12 min in 2 pauses`; the count only when the doc lists the pauses). The `×` speed button in
  the control bar is the extra playback multiplier on top of that, as before.

## What the app must send

For a time-lapse take, the experiment doc must carry `timelapse.intervalSec`, `frameCount`, and
`duration` = the real span in whole seconds (`round((frameCount − 1) × intervalSec)`, at least 1);
`startedAt` and `complete` are welcome, and a paused take sends `timelapse.pausedSec` plus
`timelapse.pauses` (each pause's `startSec` / `endSec`, real seconds since `startedAt`, in order) so the
clock stays exact. Ordinary recordings keep writing `duration = frames / 5`
(`frameCount` is optional for them and, when present, must equal the number of uploaded frames). Key
moments' `tSeconds` are recording seconds on the same axis.

# Camera-timed recordings (2026-11-19)

Since 2026-11 the capture app files an ordinary (non-time-lapse) recording **camera-timed**: one frame of
the pack for every frame the camera delivers — about 8.3 a second, unevenly spaced (gaps of 70–190 ms,
and one of about 1.4 s whenever the camera's shutter recalibrates) — instead of resampling the camera
onto the 5 fps grid. Such a take has **no `data_N.png`**: the infrared picture is painted from
`data_N.dat` wherever it is shown. Time-lapses, street views and photo sets keep their formats, and so
does every recording uploaded before; a doc without the marker below behaves exactly as it always has.
Design on the app side: its `android/.../flir/FlirRecordingWriter.kt` header and `src/lib/frameTime.ts`.

## The contract

`experiments/{id}` (sourceType `recording`), besides the usual fields:

| field | meaning |
| --- | --- |
| `timing: 'camera'` | The marker. Absent on every other recording. Never together with `timelapse`. |
| `frameCount` | Always present on these: frames uploaded (`data_1 … data_frameCount`). |
| `fps` | The take's **mean** frame rate (frameCount / covered seconds, about 8.3). Only a fallback pace — a frame's time is in `frame-index.bin`. |
| `duration` | Whole seconds of real time, at least 1, as before. |
| `palette` + `paletteSource: 'app'` | The palette the picture is painted through (`src/utils/paletteData.ts` holds all eleven). |
| `thumbnailURL` | Download URL of `recordings/{recordingId}/thumb.jpg`. |

`recordings/{recordingId}/` in Storage:

| object | |
| --- | --- |
| `data_N.dat` | Unchanged: zlib, 120 × 160 cells × 4 bytes. |
| `vis_N.jpg` | Optional per-frame visible picture, as before. |
| `frame-stats.bin` | Optional, as before. |
| `frame-index.bin` | **New.** UTF-8 JSON sent as `application/octet-stream` — and named `.bin` on purpose: Storage records a `*.json` object as `application/json` whatever type it is sent with, which the storage rule refuses (the app could not finish an upload under the first name, `frames.json`). Its content: `{"version":1,"timing":"camera","frameCount":N,"frameCaptureMs":[…],"frameScaleMin":[…],"frameScaleMax":[…]}`. `frameCaptureMs[i]` is frame i+1's capture time, integer ms since the take's start, non-decreasing (frame 1 is not necessarily at 0). `frameScaleMin/Max[i]` is the °C range the camera coloured that frame over, or null. |
| `thumb.jpg` | **New.** A small JPEG of frame 1's infrared picture (the cards' thumbnail). |
| ~~`data_N.png`~~, ~~`mix_N.jpg`~~ | Not uploaded. |

Neither rules file needed a change: the experiments create rule has no field whitelist, and
`recordings/**` already takes `application/octet-stream` and `image/jpeg`.

## How the site reads it

- **The frame index** — `src/utils/frameIndex.ts` (parsing, pure) and `src/utils/frameIndexLoader.ts`
  (`loadFrameIndex`, one fetch per recording shared by every consumer; `useFrameIndex` for a component).
  A read that fails resolves null and is not kept, so the next ask retries; meanwhile time falls back to
  the mean rate (`fps`) and colour to each frame's own coldest → warmest pixel.
- **Time** — `src/utils/frameTime.ts`. `isCameraTimed(exp)`; `secondsPerFrame(exp)` is then only the
  **mean** gap. A frame's time is a `PlayerClock`'s to say (`playerClock(exp, lastFrameIndex,
  getRecordingIndex, captureMs)` → `timeOf(index)`, `indexAt(seconds)`, `holdMs(index)`): the old
  `index × secondsPerFrame` to the digit for an ordinary recording or a time-lapse, each frame's own
  capture time for a camera-timed take. The player, the control bar's readout, the T(t) chart's rows /
  playhead / click-to-seek (`LineplotData.timeOf` / `indexAt`), key moments and their time editor
  (`playerFrameRate.timeOf` / `indexAt` in the store), annotation windows, the Δ view's reference label,
  the 3D surface's labels, the Lab Assistant's seek / playhead, and the Experiments section's and the
  analyzer AI's `CloudTake.timeOf` / `frameAt` / `spanSec` all ask it. **Nothing may multiply an index by
  `secondsPerFrame` for a time any more** — for these takes it is only a mean.
- **Trimmed clips.** Recording frame n is on screen from its own capture time to the next frame's — its
  *slot* (the take's last frame gets the mean gap). A player index's time is the sum of the slots of the
  frames before it: untrimmed, exactly the frame's capture time since frame 1; trimmed, a cut collapses
  as on every other clip while each kept frame keeps the length it had, so the clip plays and reads as
  its kept stretches run end to end in real time. Events the take's own files date by recording frame
  (frame-stats.bin: camera moves, shutter calibrations) use `CloudTake.recordingTimeOf` — the whole
  take's clock, as before.
- **Playback runs in real time** (`imagePlayer.tsx` `armCameraTick`): each tick is due when the frame it
  shows was taken, divided by the speed, counted from where playback started (so a late tick does not
  delay the rest), re-anchored when the playhead is moved or playback falls more than half a second
  behind. An ordinary recording and a time-lapse keep their fixed 5 fps interval.
- **The infrared picture** — `src/utils/thermalPaint.ts` (pure) and `thermalPaintDom.ts` (canvas → PNG).
  The capture app's recipe (its `src/lib/thermalRenderParams.ts`; the two must stay the same picture):
  temperatures normalised over the range (held to 16 bits), interpolated bicubically (Catmull-Rom, edge
  cells repeated) **as temperatures**, then looked up in the palette's ramp with `floor(v · N)`. 720 × 960,
  as the app paints it; a separable two-pass kernel, about 11 ms a frame in Node on the development PC
  (plus 2 ms to inflate and decode the frame). The range is `frameScaleMin/Max` for the frame, else its
  own min / max; the scale bar reads the same range (`ScaleBar` `paintedRange`). Used by the analyzer's
  player (Infrared, and the infrared half of the synthesized Blended), the key-moment thumbnails
  (`fetchRecordingFrameDataUrl(…, painted)`), and — as range + palette, with no picture at all — the
  digital twin's live colours (`useLiveTwinFrame` `cameraTimed`). The player keeps the last 150 painted
  frames as pictures and preloads nine frames ahead (a second).
- **The synthesized Blended frame is made in workers** (2026-11-20; `src/utils/blendedFrame.ts` hands the
  work over, `blendedFrameJob.ts` is the work, `blendedFrame.worker.ts` the worker, `jobPool.ts` the
  bookkeeping). It was made on the page — paint the infrared picture, encode it as a PNG, decode that and
  the visible frame, read both back, blend, encode a JPEG: about 145 ms a frame on the development PC,
  most of it holding the main thread, so 8 frames a second at best for a take that plays 8.3. Blended
  playback stuttered: measured in headless Chrome with a stand-in for the player's loop (a frame due
  every 120 ms, nine asked for ahead), the page was blocked for 3.7 of 8.6 seconds, in stretches of up to
  200 ms, and one frame in ten never reached the screen. Now the page fetches the frame's files and a
  worker does the rest, painting the infrared half straight into the blend (no PNG on the way): the
  same sixty frames all on time, no task over 50 ms on the page, and the same picture byte for byte. A
  frame costs a worker about 100 ms there (decode 15, paint 10, read-back 8, blend 35, JPEG 27), so one
  worker makes about 12 a second and two about 20; up to four are started, only as jobs wait, never more
  than the machine has cores to spare. When more frames are asked for than can be made, the newest goes
  first — those are the ones still ahead of the playhead. A browser whose workers cannot do it (no
  OffscreenCanvas, a worker that will not start, a job a worker fails and the page can do) falls back to
  the page for good. A recording with stored renders (`data_N.png`) goes the same way, its picture
  decoded in the worker. Infrared alone is still painted on the page: about 45 ms a frame, which keeps up.
  Not looked at here: every Visible and Blended frame shown stays cached as a data URL for as long as the
  player is open (only painted Infrared frames are limited to the last 150), which a long take will feel
  in memory.
- **Copies and clips** carry `timing` and `fps` (`services/experiments.ts` `timelapseFields`): they share
  the source's frames. Deleting a recording clears its Storage prefix whole, so the two new objects go
  with it.
- **Functions.** `functions/src/thermal.ts` `recordingTiming` gives the sampler the mean gap
  (`cameraTimedGapSec`); its one caller is `analyzeTwinBuilding`'s walk-around, which only uses frame
  times to drop the first and last moments. That path attaches a frame's `data_N.png` to the model as an
  aid when there is one; for these takes there is none and the visible photo goes alone, as it already
  does for a set with a missing render. Street-view baking and photo sets are untouched.

## Deploy order

**The website and the functions first, then the app release that uploads the format.** A site that does
not know `timing: 'camera'` would ask Storage for `data_N.png` (404 on every frame) and time the frames
at 5 fps. App versions released before the format cannot show such a take's infrared view either; they
are told to update.
