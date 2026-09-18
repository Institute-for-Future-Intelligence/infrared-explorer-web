# Street-view bake — app uploads → all-intra streams

> 2026-09-18. Companion to `docs/street-view-web-plan.md` §8 (which recorded the symptom and
> the frames-mode mitigation) and to the app repo's `docs/proposals/street-view-browser-redesign.md`
> §4.1 (the stream player). Code: `functions/src/streetViewBake.ts` (recipe + doc contract, unit
> tested), `functions/src/index.ts` (`onStreetViewCreated`, `bakeUnbakedStreetViews`),
> `scripts/bakeStreetViews.mjs` (backfill / redo / encode-only).

## 1. Why

Both panorama viewers look around by **seeking one mp4** — the app's `PlaybackScreen` street
mode (`src/lib/streetViewBrowse.ts` stream path, downloaded to disk, ~20 ms per seek) and the
web `streetViewViewer.tsx` `video` mode (all-intra, seeked in place). The 236 seeded panoramas
have that mp4 because it was baked **offline** (`scripts/streamAll.mjs`), plus a stitched
`pano.jpg` (`scripts/stitchAll.mjs`).

An **app upload had neither**. It is the recording contract, 4 × N objects under
`streetviews/{svId}/`: `data_N.dat` (120×160 temperatures, ~26 KB), `data_N.png` (the palette
render, upsampled to the camera's 1080×1440, ~380 KB lossless), and the optional `mix_N.jpg`
(MSX blend, ~600 KB) / `vis_N.jpg` (visible light, ~350 KB). Both viewers therefore fell back
to fetching **one frame per drag step**, and the upload endpoint the app uses cannot set
`Cache-Control` (create-only rule, no metadata PATCH), so every one of those fetches was served
`private, max-age=0` — never cached, never CDN-served.

Measured on the first upload (`d50b7c30dff8deaece266617`, "Greenleaf st", 110 shots, 440
objects, 174.8 MB): 242 ms per `data_N.png` from a wired desktop, a second fetch of the same
frame no faster, ≈ 27 s of network for one 360°. In the app `downloadFramesFromStorage` fetches
frame 1, returns, then pulls the other 109 **serially** in the background while look-around is
clamped to what has landed — "the view does not move, then jumps". Same clip, same cause on the
web. The capture itself was clean (0 duplicate frames, 3.2° median step, 346° sweep, full
attitude) — this was never a recording-side problem.

## 2. What the bake writes

Under the same `streetviews/{svId}/` prefix (so `onStreetViewModerated` quarantine and
`onStreetViewDeleted` purge already cover it):

| object | source | scaled to | when |
|---|---|---|---|
| `stream_mix.mp4` | `mix_N.jpg` | 720 px wide, crf 24 | every `mix_N.jpg` present |
| `stream_ir.mp4` | `data_N.png` | 480 px wide, crf 22 | always (contract) — 4× the 120×160 sensor |
| `stream_vis.mp4` | `vis_N.jpg` | 720 px wide, crf 24 | every `vis_N.jpg` present |

Recipe = `streamAll.mjs` applied to an image sequence: `-framerate 5`, every frame a keyframe
(`-g 1 -keyint_min 1 -sc_threshold 0`), last frame cloned for 8 s (`tpad`) so the real tail
never sits in ExoPlayer's near-EOS zone, `yuv420p`, `+faststart`. Greenleaf st: mix 12 MB,
ir 2.6 MB, vis 8 MB — against 175 MB of frames.

On the doc:

| field | meaning |
|---|---|
| `streamUrl` | the **default** stream: the blend when there is one, else the IR render — the view the app's own player shows for the same capture (`meta.tracks.video`, blended > ir > visible). Clients that predate the tracks read only this. |
| `streamView` | which view `streamUrl` is: `'blended' \| 'ir' \| 'visible'` |
| `streamMixUrl` / `streamIrUrl` / `streamVisUrl` | every track that was baked |
| `videoDurationSec` | **content** duration = `frameCount / 5`; the frame→time basis both viewers seek by (app `panoSeek.ts`). The file is 8 s longer. |
| `streamFrameCount`, `bakeVersion`, `bakedAt` | what was encoded, with which recipe, when |

Every frame object is also retagged `Cache-Control: public, max-age=86400` — a day, not the
seeds' year, because uploads are UGC and a takedown must not be outlived by an edge cache. The
web keeps reading `data_N.dat` per frame for the thermal tools; the app fetches the same set for
measuring. Neither depends on the header, both benefit from it.

## 3. When it runs

- **`onStreetViewCreated`** (Firestore `streetviews/{svId}` onCreate, 2 GiB / 2 vCPU / 540 s):
  the app creates the doc *after* every frame is in Storage, so the trigger sees a complete
  upload. Seeds (`ownerId 'system'`, `legacy`, `virUrl`) and anything with fewer than two
  frames are skipped before any work starts.
- **`bakeUnbakedStreetViews`** (nightly 04:30 America/New_York): re-lists non-seed docs and
  bakes up to three that `bakeDecision` still flags — a failed or timed-out trigger run, or
  a recipe bump (`STREET_BAKE_VERSION`).
- **`scripts/bakeStreetViews.mjs`**: `--id=<svId>` / `--all [--limit=N]`, `--redo`, `--dry`,
  and `--out=<dir>` (encode only, nothing written to the cloud). Needs
  `npm --prefix functions run build` first; runs the same module.

## 4. What the viewers do with it

- **App** (`streetViewBrowse.ts`): a doc with `streamUrl` takes the stream path — download to
  `video.mp4`, look around locally. For an upload (no `virUrl`) the open then fetches the
  `data_N.dat` frames in the background for measuring (there is no `.vir` to convert) and the
  companion tracks as `ir.mp4` / `vl.mp4` with `meta.tracks`, so the player's view menu can
  switch between blended / thermal / visible — the same three views the local capture had.
- **Web** (`streetViewViewer.tsx`): `video` mode over `streamUrl`; a view menu over the track
  URLs; the thermal tools read the shown frame's `data_N.dat` as they did in frames mode.
  The `frames` fallback remains for an upload the bake has not reached yet.

## 5. Not done here

- **`pano.jpg` / `pano_temp.png`** for uploads (the web's full-screen wide panorama). The
  stitcher only reads legacy `.vir` clips today and its placement is a known separate
  workstream (app memory: the vertical IMU push / early-frame heading problems); wiring it
  to `data_N.png` + `shots[]` (which now carry roll and full quaternions) is the next step,
  not this one.
- **Not uploading `mix_N`/`vis_N` at all** (108 of Greenleaf st's 175 MB). Kept: they are the
  source the blend/visible tracks are cut from, and the recording contract for experiments.
