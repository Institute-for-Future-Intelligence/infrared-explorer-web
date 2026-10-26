# Synced copies — do not edit here

The TypeScript files in this folder except `config.ts`, `secrets.ts` and `store.ts` are
**verbatim copies** of files in the app repository, `infrared-explorer-app/functions/src/`: what the
model is told (`prompt.ts`, `toolSchemas.ts`) and how it is called (`llm.ts`, with
`partialJson.ts` and `textDiff.ts`). Edit them there, then run `npm run sync:lab-core` here. A
change made here is lost on the next sync. The analyzer's Ask AI and AI Report run on them
(`functions/src/recordingAi/`; docs/analyzer-ai-app-flow-plan.md).

- Source commit: `30ff150a7d15cbbe40575110811cd1397e9950c6`
- Source commit date: 2026-10-26T12:37:23-04:00
- Synced on: 2026-10-26T16:37:26.572Z

Files copied:

- `prompt.ts`
- `toolSchemas.ts`
- `llm.ts`
- `partialJson.ts`
- `textDiff.ts`

Website-side shims beside them (not synced), standing in for what the copies import:

- `config.ts` — the constants `prompt.ts` and `llm.ts` read (the safety rule, the code-only switch, the
  output cap, the reasoning effort, the web-search switch) and the provider / model-spec types.
- `secrets.ts` — `apiKeyFor` over the website's own Secret Manager params (../aiSecrets.ts).
- `store.ts` — the document types `prompt.ts` names (ProjectDoc, ImageDoc, TurnDoc …), types only; the
  recording AI's own store (../recordingAi/store.ts) uses the same shapes.
