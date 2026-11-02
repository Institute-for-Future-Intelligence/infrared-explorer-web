# Synced copies — do not edit here

The TypeScript files in this folder except `config.ts`, `secrets.ts` and `store.ts` are
**verbatim copies** of files in the app repository, `infrared-explorer-app/functions/src/`: what the
model is told (`prompt.ts`, `toolSchemas.ts`) and how it is called (`llm.ts`, with
`partialJson.ts` and `textDiff.ts`). Edit them there, then run `npm run sync:lab-core` here. A
change made here is lost on the next sync. The analyzer's Ask AI and AI Report run on them
(`functions/src/recordingAi/`; docs/analyzer-ai-app-flow-plan.md).

- Source commit: `45ce3f72039a1064db70aa1a9655f7ac66d5b063`
- Source commit date: 2026-11-02T13:31:36-05:00
- Synced on: 2026-11-02T18:31:41.696Z

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
