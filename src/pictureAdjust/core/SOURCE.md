# Synced copies — do not edit here

The TypeScript files in this folder are **verbatim copies** of files in the app repository,
`infrared-explorer-app/src/lib/`: the Process recipe (the app's Adjust panel) — what its sliders and
effects do to a picture (`pictureAdjustParams.ts`, `pictureEffectParams.ts`) and the order they go one
over the other (`adjustCompose.ts`). Edit them there, then run `npm run sync:lab-core` here. A change
made here is lost on the next sync.

- Source commit: `1a4ed37b716d02005eb653e5b112aa6b36885283`
- Source commit date: 2026-11-20T22:22:06-05:00
- Synced on: 2026-11-21T16:37:46.542Z

Files copied:

- `pictureAdjustParams.ts`
- `pictureEffectParams.ts`
- `adjustCompose.ts`

Website-side files beside this folder (not synced): `../adjustFrameJob.ts` runs the recipe on CanvasKit
— the app's `pictureAdjust.ts` (its `rasterKit`, `drawOnce`, `adjustShader`) written against
CanvasKit's API over WebGL; `../adjustFrame.ts` hands frames to it in workers; `../doc.ts` reads the
settings an upload carries (the app's `experimentDoc.ts` `PictureAdjustDoc`).
