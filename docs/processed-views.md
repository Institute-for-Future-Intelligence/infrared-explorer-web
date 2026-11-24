# Processed views: the app's Process on the website

The capture app has a Process panel (its code calls it Adjust): eleven sliders and a stack of effects,
kept per view of a capture, never written into the capture's files. Since 2026-11-20 an upload carries
those settings on its experiment document. Since 2026-11-21 the website draws them: a view that was
processed on the phone opens processed here.

Since 2026-11-23 the website has the panel too: a view can be processed here, and what the owner keeps
goes back on the document, where the app reads it.

Phase 1 was drawing them, phase 2 is the panel here ("The Process panel", below), phase 3 is the app's
half of the round trip (at the end).

## What is in the cloud

| | key on `experiments/{id}` | shape |
|---|---|---|
| a recording | `pictureAdjust` | `{ version: 1, views: { ir?, visible?, blended? } }` |
| a photo set | `photoPictureAdjust` | `{ version: 1, photos: [views \| null, …] }`, one entry a photo in capture order |

Each view's value is the eleven sliders (whole steps) and `effects?: [{ effect, amount }]` in the order
they were added. Neither key exists when nothing was processed. The frames under `recordings/<id>/` are
always the capture as made. Written by the app (`experimentDoc.ts` there; its
`docs/cloud-classroom-integration.md` §3.2), read here by `src/pictureAdjust/doc.ts`: through the app's
own sanitizer, and a `version` this build does not know means the capture is shown as made.

A still's fourth view on the phone, `captured`, has no counterpart among the three views here and is
not read.

## How a processed view is drawn

**The processed frame is still a picture handed to the same `<img>`.** The player gets a frame's picture
as it always has (the stored render, the painted infrared picture, the synthesized Blended one), and where
the view has settings the picture goes through one more stage before it is cached
(`imagePlayer.tsx` `loadImage`). So playback, the frame cache, screenshots, Set as thumbnail, key moments
and the capture handed to the AI all show the processed picture with nothing changed in them. Replacing
the `<img>` with a WebGL canvas would have meant redoing every one of those; CSS filters cannot do the
effects and are not in a screenshot.

**The recipe is the app's own source, run on Skia's own code.** `src/pictureAdjust/core/` holds three
files copied from the app by `npm run sync:lab-core` and never edited here: the numbers and the sliders'
shader, the effects' shaders, and the order they go one over the other. `adjustFrameJob.ts` runs them on
CanvasKit (Skia compiled to WebAssembly, the version the app's tests hold the recipe to); it is the
app's `pictureAdjust.ts` written against CanvasKit's API. A hand port to WebGL would have been a second
implementation to keep in step with every new slider and effect.

**On the GPU, in workers.** Measured 2026-11-21 in headless Chrome:

| | 720 × 960 | 1080 × 1440 |
|---|---|---|
| CanvasKit's CPU surface | 0.7 s (tone sliders) to 14 s (Blur + Emboss) | not measured |
| WebGL, in a worker | 17–21 ms a frame | 28–40 ms |
| Chrome's software WebGL | 24–125 ms | 72–290 ms |

So there is no CPU path. Frames are made in up to two workers (`adjustFrame.ts`, on `utils/jobPool`),
each with CanvasKit and one WebGL context; the page was never blocked. Where a worker cannot do it
(Safari before 17 has no WebGL off the page) the page does, about as fast, holding the thread for up to
about 100 ms at a time. Where nothing can (no WebGL), three failures in a row end the attempts for the session
and the pictures are shown as made.

**CanvasKit is 7.2 MB of wasm (about 2.9 MB compressed), fetched only when a processed frame is first
asked for**, then cached by the browser. While it loads, a frame that has waited 400 ms goes up as made
and is replaced when its processed picture is ready, rather than the player staying empty.

**The picture differs a little from the phone's.** The recipe is the same; what it is applied to is not
quite: the website's painted infrared picture and its Blended synthesis are not the phone's pixel for
pixel, and a made picture comes back as a JPEG.

## What a visitor sees

- A processed view opens processed. The toolbar's Process key (three sliders, beside the view switch) is
  lit while the view on screen is processed; it opens the panel, whose compare key shows the picture as
  made while it is held. (Phase 1 had a toggle there instead; the plan before that had a chip on the
  picture, but the frame's corners are taken — scale bar, charts, legends — and a chip there would be
  in every screenshot.)
- Over a processed Infrared or Blended picture the scale bar is not drawn (its colours are no longer
  the scale's — the app's rule, `hidesScale`) and its toolbar key says so. Sensors, isotherms and charts
  read the temperatures and are unchanged. The AI reads the temperatures too.
- A photo set is processed photo by photo; the toggle is offered on the photos that have settings.
- A copy and a clip carry the settings (`cloneExperimentById`, `cloneExperiment`).
- Key-moment thumbnails rebuilt after a reload are processed where the Infrared view is.
- **The card's thumbnail is the app's.** Since 2026-11-21 the app sends, as `recordings/<id>/thumb.jpg`,
  the picture its own gallery shows the capture by when it goes up — processed if it was, the player's
  Set as Thumbnail shot if there is one — and `thumbnailURL` points at it (the app's
  `docs/DECISIONS.md`, "The cloud's thumbnail is the app's thumbnail at upload"). Nothing is drawn
  here for a card. Two places knew the cover as a photo's render and now know `thumb.jpg` too: a photo
  set's cover after a reorder (`utils/photoOrder.ts` `coverAfterReorder`) and the Experiments Lightbox,
  which shows a photo's own render and not the small thumbnail (`labProjects/capturePictures.ts`
  `photoPictureUrl`). The owner's Set as thumbnail here replaces it, as before, with the player as
  displayed.

Not processed in phase 1: the card of a capture uploaded before the app sent its own thumbnail (the
owner's Set as thumbnail captures the processed picture), the photo strip's thumbnails, the older
showcase videos, street views.

## The Process panel

`src/pictureAdjust/processPanel.tsx`, opened by the toolbar's Process key on any recording or photo set
(not while the Δ view or the 3D surface has the frame). It is the app's panel laid out for a page:

- **Beside the picture, never over it.** It stands where the workspace card is (Info / Charts / Ask AI),
  which stays mounted behind it: the column next to the frame on a desktop, the block under it on a
  phone. The picture is what is being judged — the app's rule.
- **One page** (user's call, 2026-11-23; the app has two tabs for want of room). First the sliders, all
  eleven at once, each with its position; a click on the number puts it back to zero. **Auto** sets
  Brightness and Contrast from the picture on screen (the app's rule and numbers, `panelPictures.ts`).
  Under them the **effects**: the picture under each, small — made once, as the panel opens on the
  picture, and not again for a slider or another frame (user's call). A click puts one on; they stack in the order
  they are put on, and each that is on has its own slider under the row, brought into sight when the
  effect is put on (on a short page it is past the end of what shows). A click on one that is on takes
  it off, and the pointer over it shows a cross to say so (user's call; the app's second tap brings the
  effect's slider up first, there being one slider there).
- **Compare** is held: the frame as made is laid in the picture's place (`peekSrc`) and the processed
  picture is not touched, so letting go has it back at once. **Undo / Redo** walk the steps since the
  panel opened on the picture (`steps.ts`); **Reset** is a step.
- **A second click on the toolbar's key** ends Process and keeps what was done, as Done does. While the
  panel is open the Δ view, the 3D surface, Reset and the Clip page wait (greyed): they take the frame
  away from the panel, or the page from under it.
- **One picture at a time.** A recording's view is processed whole; a set's photos one by one. Switching
  the view, or the photo, while the panel is open moves the panel to that picture (its steps start over)
  and keeps what was done to the last: everything is in one working copy until Done or Cancel.
- **The frame follows the pointer.** Every change makes the frame on screen again from its picture as
  made, which the player holds for the last few frames (`fetchMade`) — one at a time, the latest settings
  winning (`remakeShown`). The frames after it are made once the settings have rested.
- **Done.** The owner's settings are written to the document (`savePictureAdjust`: the two keys above,
  in the app's shape, removed when nothing is processed) — everyone who opens the experiment sees them,
  and the app reads them on a download. A visitor's stay in the page's copy of the experiment, like the
  thermometers they place: gone on leaving, taken off by the toolbar's Reset, carried by a copy they
  save. Cancel keeps nothing.

Not done here: the card's thumbnail does not follow a change made in the panel (the owner's Set as
thumbnail captures the processed picture); a visitor's changes do not raise the "save a copy" note;
there is no Save as New File (a copy of the experiment is the site's way).

## Checking it

- `src/pictureAdjust/doc.test.ts` — reading and writing the settings; `steps.test.ts` — Undo / Redo
  (both under `npm test`).
- `npm run check:picture-adjust` — the engine for real: builds the site, opens a page on its built worker
  in headless Chrome, holds the sliders to the app's reference implementation, runs every effect, and
  compares the page's path to the worker's. **Run it after a sync that changed `src/pictureAdjust/core/`**:
  it is where the recipe's shaders meet WebGL's compiler.

## The round trip (the app's half)

In the app's repository (its `docs/DECISIONS.md`, "Process settings make the round trip", 2026-11-23):
a recording saved from the cloud to a phone's gallery opens with the document's settings, and the app's
Done on a capture that has already gone up rewrites them on its document. Between the two sides the
last one to write wins: the phone sends a recording's settings whole, and one photo's entry of a set.

Still open: a cloud recording the app only streams is shown there as made; a copy already on a phone
does not pick up settings changed here afterwards.
