# Time-lapse experiments (2026-09-28)

The capture app records **time-lapse** takes: one thermal frame every `interval` (1 s … 10 min, default
60 s) for up to 24 h. The frames are uploaded exactly like an ordinary recording
(`recordings/{recordingId}/data_N.dat`, `data_N.png`, `vis_N.jpg`, `mix_N.jpg`, N = 1..frameCount), so
every frame reader serves them unchanged. What changes is the **time axis**: a frame index is minutes or
hours of recording time, not a fifth of a second. Design on the app side:
`infrared-explorer-app/docs/proposals/time-lapse-recording.md` (§2 #10, §3.4, §4 WP-D).

## The rule: pacing vs time axis

- **Playback pacing stays 5 fps** (`FPS` in `src/utils/constants.ts` / `functions/src/thermal.ts`): a
  time-lapse plays as a sped-up film — a 24 h take of 1441 frames plays in 4 min 48 s. `FPS` is kept only
  where it means pacing — the player's tick interval and preload reach, the 3D surface's play loop — and
  for the control bar's clock, which is the film's own time (below).
- **Every frame → time conversion goes through `src/utils/frameTime.ts`.** Nothing else may write
  `/ FPS`, `* 5` or `1 / FPS` for a time.

## The doc contract (`experiments/{id}`, sourceType `recording`)

New optional fields, written by the app:

| field | meaning |
| --- | --- |
| `timelapse: { intervalSec, plannedSec?, pausedSec? }` | Present (`intervalSec > 0`) ⇒ this is a time-lapse. Frame N (1-based; player index N−1) was taken at (N−1) × intervalSec seconds of **recording** time. Pauses are already excluded from that grid, so the axis is uniform. |
| `frameCount` | Frames uploaded (`data_1 … data_frameCount`). Present on time-lapse docs (may appear on ordinary recordings later). Absent ⇒ derived as `round(duration × 5)`. |
| `duration` | **Always seconds of recording time.** Time-lapse: the real span, `round((frameCount − 1) × intervalSec)`, at least 1. Ordinary recording: unchanged (frames / 5). When both `duration` and `frameCount` are present, neither is derived from the other. |
| `startedAt` | Epoch ms the take started. Display only (the capture-time overlay). |
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
- `timeAxisFor(spanSec)` / `formatTimeAxis(sec, axis)` — the unit a chart axis is drawn in: seconds below
  3 min, minutes below 3 h, hours above, with the axis title (`Time (Second)` / `Time (Minute)` /
  `Time (Hour)`).
- `formatIntervalSec(sec)` — "1 s" / "2.5 min" / "1 h" for the Info tab and the card tooltip.

`utils/helpers.ts formatDuration` now renders `h:mm:ss` from an hour up (`m:ss` below, as before).

## What changed (web)

Client — every time use of `1/FPS`, `* 5` or the duplicate `RECORDING_FPS` now reads the helpers:

- `useMappingIndex(segments, experiment)` takes the experiment (was `duration`) and uses `lastFrameIndexOf`.
- `imagePlayer`: one `spf = secondsPerFrame(experiment)` feeds the capture-time overlay, key-moment / Q&A
  instants (`tSeconds`), the T(t) rows
  (`LineplotData.secondPerFrame`), the published `playerFrameRate`, the Δ-view reference label,
  annotation windows, the Lab Assistant's seek / playhead and the 3D surface's clock labels
  (`ThermalSurface3D` gained an optional `secondsPerFrame`; its `fps` stays the play pacing).
- `linePlot` keeps its rows in seconds (playhead, click-to-seek, fit window and CSV unchanged) and only
  chooses the tick unit and axis title from the span, so a short clip's axis is exactly what it was.
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

The control bar is the FILM's clock: its readout, scrub preview and slider tooltips go by the video's
length (frames at 5 fps — a 1441-frame take reads `00:00/04:48`), a time-lapse included, so scrubbing a
24 h take feels like any other clip. The frames' real times live elsewhere:

- The toolbar's clock button — shown only for a time-lapse whose document carries `startedAt` — overlays
  the shown frame's **capture time** (`Sep 28, 2026 14:10:15`) at the bottom-left of the frame
  (`ExperimentGraphOption.captureTime`, saved with the other overlay toggles; it moves to the bottom-right
  while the Δ view's legend owns the bottom-left). A take with `pausedSec > 0` is approximate (no visible
  marker — the pill's tooltip says so and by how much): its grid excludes the pauses but the web has no
  per-frame capture times, so a frame after a pause was really taken up to `pausedSec` later than
  `startedAt + grid` says (the app, which has `frameCaptureMs`, is exact). The time is computed on the
  RECORDING frame (`getRecordingIndex`), so a trimmed clip of a take reads right.
- The charts' time axes, key moments, annotation windows and the report's instants stay in recording
  seconds (`frameTimeSec`), hours apart for a long take.
- The Info tab's time-lapse row states the **speed**: `every 1 min · plays 300× real time`
  (`playbackSpeedFactor` = interval × 5 fps). The `×` speed button in the control bar is the extra
  playback multiplier on top of that, as before.

## What the app must send

For a time-lapse take, the experiment doc must carry `timelapse.intervalSec`, `frameCount`, and
`duration` = the real span in whole seconds (`round((frameCount − 1) × intervalSec)`, at least 1);
`startedAt` and `complete` are welcome. Ordinary recordings keep writing `duration = frames / 5`
(`frameCount` is optional for them and, when present, must equal the number of uploaded frames). Key
moments' `tSeconds` are recording seconds on the same axis.
