# Photo-set experiments

Status: implemented client-side on 2026-09-09 (with the matching capture-app upload); not yet deployed.
Nothing here needs a rules or index deploy — a photo set uses the recording rules as they stand.

## What a photo set is

The capture app can now upload a GROUP of thermal photos as ONE experiment. Each photo in the app is a
still plus a one-frame thermal bundle (temperatures + the three renders, in the recording contract
layout); a set is several of those sent together, in capture order. On the web a photo set is an
experiment like any other — it has a title, a description, a subject, comments, ratings, a visibility
tier, clones — but the analyzer opens it in a **photo browser** instead of the player: a filmstrip of
the photos to page through, with the same spatial analysis tools (thermometers, line profiles,
isotherms, the scale bar and hot/cold markers, the Δ view between two photos, the 3D surface,
annotations) working on whichever photo is shown.

## The contract (written by the app, read here)

### Storage — the recording layout, one frame per photo

```
recordings/{recordingId}/data_1.dat, data_1.png, vis_1.jpg, mix_1.jpg   ← photo 1
recordings/{recordingId}/data_2.dat, data_2.png, vis_2.jpg, mix_2.jpg   ← photo 2
…                                                                       ← photo photoCount
```

Exactly the objects a recording puts up, so nothing that reads frames changes: the ImagePlayer's
fetches, `utils/recordingFrame.ts`, thumbnails (`thumbnailURL` is `data_1.png`), `storage.rules`
(create-only, public read), the `recordingOwners` ledger and `beginRecordingUpload` /
`deleteRecording`, `deleteAccount`'s prefix purge (it is keyed by `recordingId`, whatever the
`sourceType`), and clone-by-reference.

### Firestore — `experiments/{expId}`

Same doc as a recording (`ExperimentDoc`, `src/types.ts`), with:

| field | value |
|---|---|
| `sourceType` | `'photos'` (`ExperimentType.Photos`) |
| `recordingId` | the Storage prefix above |
| `photoCount` | number of photos = number of frames (≥ 1) |
| `duration` | **0** — a set has no time axis; nothing should read it for a set |
| `photoCapturedAt` | epoch ms per photo, `0` = unknown; length `photoCount` |
| `photoTitles` | optional caption per photo (`''` = none); present only when some photo has one |
| `palette` + `paletteSource:'app'` | when every photo was baked with the same palette |
| `photoPalettes` | otherwise: the key per photo (`null` = unknown); never together with `palette` |
| `isRaw: true`, `segments: null` | a set is never trimmed |

The create rule is unchanged — it does not look at `sourceType` or `duration`. The app's builder
(`experimentDoc.buildPhotoSetExperimentDoc` in the app repo) mirrors the rule and additionally
refuses arrays that do not line up with `photoCount`.

## What the web does with it

- **`experimentAnalyzer`** routes `'photos'` to `ImagePlayer` (everything not `'video'` goes there).
  Thermometers load from the subcollection, as for a recording.
- **`ImagePlayer`** in photo mode (`isPhotoSet`): `lastFrameIndex = photoCount − 1`, photo *k* is
  frame *k* (no segment mapping), no play loop or scrubber — `PhotoStrip` (prev / next, "Photo k of
  N", the caption, a thumbnail filmstrip) replaces `ControlBar`; ← / → still page. **The frame box is
  the recording frame's box**: the strip is exactly the control bar's height (70px, `.photo-strip` /
  `.control-bar` in `App.css`) and the box's width is pinned to the recording frame's 3:4 (the app's
  120×160 thermal frame) rather than following the shown photo's own shape — a thermal photo fills it
  exactly, a picture of another shape (an imported camera JPEG) is letterboxed on black
  (`object-fit: contain`, `.photo-set` rules). So a set is exactly as wide and tall as a recording, and
  paging through mixed shapes never resizes the column or reflows the workspace. The Clip tool page
  is hidden (nothing to trim); the T(t) chart chip is hidden (no time axis) while T(x) / T(y) / T(l) /
  N(T) stay; annotation windows count photo numbers; the Δ view's reference label says "photo k"; the
  3D surface labels frames by number; the scale bar takes the shown photo's palette from
  `photoPalettes` when the set is mixed.
- **Workspace**: Key moments are left out (they are chapters on a timeline). Ask AI / AI Report stay
  gated to recordings and videos, as before. **3D Twin** (2026-09-10) opens for a set: the photos are
  taken as several standpoints around ONE building, a vision model writes the building as a small
  three.js scene (its massing, columns, glazing, site) and says where each photo's camera stood; the
  scene runs in a sandboxed frame with a realistic or a simulated-thermal look. Same `twinScene` field
  and rules as a recording's twin, told apart by `kind: 'building'`; see docs/digital-twin-plan.md §17.
- **Cards** (`components/card/card.tsx`) show "N photos" in the corner pill where a clip shows its
  duration; every grid that renders cards passes `sourceType` / `photoCount` through, and the Recent
  page's history snapshots carry `photoCount`.
- **Raw Data** lists photo sets alongside recordings (`useRawExperiments`, the Me hub).
- **Clones** (`cloneExperiment`, `cloneExperimentById`) copy the photo fields by reference like
  `recordingId`, and copy thermometers as they do for a recording.

## Not yet

- **AI analysis** (`generateLabReport`, `answerExperimentQuestion`, the Lab Assistant's
  `read_experiment_data`, `getExperimentData`): the recording sampler walks `duration × 5` frames and
  every figure it writes is "at t = …"; a set is unrelated instants. `loadThermalAnalysis` refuses a
  photo set up front with a clear message. `photoCapturedAt` gives a future photo-aware sampler a real
  clock (a time-lapse set is a legitimate T(t)).
- **T(t) over photos**: same reason — `LinePlot` assumes a uniform frame interval. With per-sample
  times it could plot a time-lapse set; until then the chip is hidden for sets.
- **Classroom submissions** carry `sourceType` but not `photoCount`; a submitted set's card says
  "Photos" without the count.

## Photos without temperature data (2026-09-09, same day)

A set may hold pictures that carry no temperatures — a screenshot-only capture, a chart, a photo
imported from the phone. The doc flags them:

| field | value |
|---|---|
| `photoThermal` | `boolean[]`, one per photo; `false` = picture only. Absent = every photo has data. |

For a picture-only photo *k* only `recordings/{id}/data_k.png` exists — the picture itself, possibly
JPEG bytes under the `.png` name (uploaded with the true content type; the rule allows both) — and
there is no `data_k.dat`, `vis_k.jpg` or `mix_k.jpg`. The app downscales a picture over 3.5 MB to a
1600 px JPEG first, so the object always clears the 5 MB rule.

The player (`ImagePlayer` in photo mode) reads the flags through `hasThermal(index)`: no `.dat` fetch
for the frame, chart sampling skips it, the spotmeter's fetch is refused, and a "No temperature data
for this photo" pill sits over the picture (`.photo-nodata-pill`); the strip caption says "picture
only". Thermometers left on such a photo read 0 — the pill is the explanation for now.

## Reordering the photos (2026-09-11)

The owner drags a thumbnail along the filmstrip to give it a new place (dnd-kit in `photoStrip.tsx`:
mouse after 5 px so a click still shows the photo, a long press on touch so a swipe still scrolls, or
from the keyboard: Space to pick up, ← / → to move, Space to drop, Esc to cancel). Viewers see the
owner's order and cannot drag.

| field | value |
|---|---|
| `photoOrder` | `number[]`, a permutation of `0..photoCount-1`: `photoOrder[p]` is the 0-based capture slot shown at place `p`. Absent = capture order. Written by the web only (`savePhotoOrder`); an ordinary owner-writable field, so no rules change. |

**The photos never move.** Photo *k* stays `data_k.*`, index *k − 1* of every per-photo array, and
frame *k − 1* to the player, so nothing that points at a photo has to follow a reorder: the frame
caches, thermometer readings, annotation windows (stored in capture numbers, so a note stays on its
photo), the twin's `photosSent`. Only what *walks* the set uses the order — the strip, "Photo k of N",
prev / next and ← / →, preloading, the slideshow the 3D surface can play, the 3D surface's timeline, the
Δ view's "photo k" label and the Lab Assistant's seek / playhead. `utils/photoOrder.ts` holds the
mapping (`normalizePhotoOrder` repairs a stored order that is not a permutation — say, written against
another `photoCount` — by dropping strays and appending missed slots); the player's `frameAtPlace` /
`placeOfFrame` are the identity for a recording.

- The set **opens on its first photo in the order**, and the caption's "+m:ss" counts from the set's
  earliest shot rather than from whichever photo is first.
- **The cover follows the first photo**: when the drop changes the first photo and `thumbnailURL` is
  still the old first photo's `data_k.png` (the app writes it as a Storage download URL; older docs hold
  the bare path — both handled), the same write points it at the new first photo's. A cover that is
  anything else is left alone.
- The annotation dialog's "From / To photo #" show and take **places**; they are converted to capture
  numbers on save. Exact for one photo, the whole set, and any unreordered set; a run of photos the
  reorder has scattered cannot be one window of places, so it shows as the places of its two ends and
  is kept as stored when the numbers are left untouched.
- Clones carry `photoOrder` (and the cover as it stands). A failed write reverts the strip and says so.
- Not covered by Ctrl+Z (like the chart settings).
