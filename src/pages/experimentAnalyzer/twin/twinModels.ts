/**
 * The models the owner may build a 3D twin with, and the request that goes with a build
 * (docs/digital-twin-plan.md §20). Two kinds of twin, two lists — mirrors of TWIN_PROGRAM_MODEL_KEYS and
 * TWIN_FIXED_MODEL_KEYS in functions/src/index.ts, which refuses a model not offered for the kind:
 *
 *   program — a scene program written from a photo set or a walk-around recording: every model the app
 *             offers, all of which read images (Claude is not offered).
 *   fixed   — the objects of one fixed-camera frame: the models that answer to a json_schema, which the
 *             fixed-camera prompt leaves the answer's fields to (DeepSeek refuses one).
 *
 * Every browser-storage access is guarded: storage can be unavailable (a private window, blocked site
 * data), and a lost preference or draft must never break the panel.
 */
import { MODEL_LABELS } from '../../../types';

export type TwinModelKey = 'deepseek' | 'gpt56' | 'gpt52' | 'gemini' | 'grok';
export type TwinBuildKind = 'program' | 'fixed';

export const TWIN_MODELS: Record<TwinBuildKind, readonly TwinModelKey[]> = {
  program: ['deepseek', 'gpt56', 'gpt52', 'gemini', 'grok'],
  fixed: ['gpt56', 'gpt52', 'gemini', 'grok'],
};

/** What a kind builds with when the owner has never chosen — the model the server used before there was
 *  a choice (TWIN_BUILDING_MODEL_KEY / TWIN_MODEL_KEY there). */
export const TWIN_DEFAULT_MODEL: Record<TwinBuildKind, TwinModelKey> = { program: 'deepseek', fixed: 'gpt56' };

export const TWIN_MODEL_LABELS: Record<TwinModelKey, string> = {
  deepseek: MODEL_LABELS.deepseek,
  gpt56: MODEL_LABELS.gpt56,
  gpt52: MODEL_LABELS.gpt52,
  gemini: MODEL_LABELS.gemini,
  grok: MODEL_LABELS.grok,
};

/** The model that traces a scene twin's measured surfaces, whichever model wrote the scene
 *  (TWIN_SURFACE_MODEL_KEY in functions/src/index.ts). */
export const TWIN_SURFACE_MODEL_LABEL = MODEL_LABELS.gpt56;

/** The server's cap on the request (TWIN_INSTRUCTIONS_MAX in functions/src/twinBuilding.ts). */
export const TWIN_INSTRUCTIONS_MAX = 1000;

/** The vendor ids the twins written before the owner chose name their model by — the only two models
 *  there were — so they still get a label and a regeneration starts from the same model. */
const KEY_BY_ID: Record<string, TwinModelKey> = { 'deepseek-flash': 'deepseek', 'gpt-5.6-luna': 'gpt56' };

export const isTwinModelKey = (v: unknown, kind: TwinBuildKind): v is TwinModelKey =>
  typeof v === 'string' && (TWIN_MODELS[kind] as readonly string[]).includes(v);

/** The key of the model that made a twin, when that model is offered for `kind`; null otherwise. */
export function twinModelOf(
  record: { model: string; modelKey?: string } | null | undefined,
  kind: TwinBuildKind,
): TwinModelKey | null {
  if (!record) return null;
  if (isTwinModelKey(record.modelKey, kind)) return record.modelKey;
  const byId = Object.prototype.hasOwnProperty.call(KEY_BY_ID, record.model) ? KEY_BY_ID[record.model] : null;
  return isTwinModelKey(byId, kind) ? byId : null;
}

/** How a twin names the model that made it: its label, else the vendor id as stored. */
export function twinModelLabel(record: { model: string; modelKey?: string }): string {
  const key = twinModelOf(record, 'program');
  return key ? TWIN_MODEL_LABELS[key] : record.model;
}

const modelPreferenceKey = (kind: TwinBuildKind) => `twin-model:${kind}`;

/** The model the owner last chose for this kind of twin, else the kind's default. */
export function savedTwinModel(kind: TwinBuildKind): TwinModelKey {
  try {
    const saved = localStorage.getItem(modelPreferenceKey(kind));
    if (isTwinModelKey(saved, kind)) return saved;
  } catch {
    // Storage unavailable: the default it is.
  }
  return TWIN_DEFAULT_MODEL[kind];
}

export function saveTwinModel(kind: TwinBuildKind, key: TwinModelKey): void {
  try {
    localStorage.setItem(modelPreferenceKey(kind), key);
  } catch {
    // Not remembered; the choice still applies to this build.
  }
}

/**
 * What the owner has put in an experiment's build form and not built yet: the request, the model picked
 * for each kind of twin, and — for a recording — which way it is to be rebuilt. Kept until a build stores
 * a twin (the record then carries what was sent) or the owner cancels, so a tab switch, a reload or a
 * failed build brings the form back exactly as it was left. `text` absent means never touched; '' means
 * deliberately cleared.
 */
export interface TwinBuildDraft {
  text?: string;
  models?: Partial<Record<TwinBuildKind, TwinModelKey>>;
  mode?: 'fixed' | 'orbit';
}

const draftKey = (expId: string) => `twin-draft:${expId}`;

/** The draft as stored, for telling later whether it changed; null when there is none. */
export function twinBuildDraftStamp(expId: string): string | null {
  try {
    return localStorage.getItem(draftKey(expId));
  } catch {
    return null;
  }
}

/** The experiment's draft, every field checked (it is browser storage, and a model may have been retired
 *  since it was saved); {} when there is none. */
export function readTwinBuildDraft(expId: string): TwinBuildDraft {
  try {
    const raw = twinBuildDraftStamp(expId);
    if (!raw) return {};
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const draft: TwinBuildDraft = {};
    if (typeof stored.text === 'string') draft.text = stored.text.slice(0, TWIN_INSTRUCTIONS_MAX);
    const models = stored.models && typeof stored.models === 'object' ? (stored.models as Record<string, unknown>) : {};
    for (const kind of ['program', 'fixed'] as const) {
      const key = models[kind];
      if (isTwinModelKey(key, kind)) draft.models = { ...draft.models, [kind]: key };
    }
    if (stored.mode === 'fixed' || stored.mode === 'orbit') draft.mode = stored.mode;
    return draft;
  } catch {
    return {};
  }
}

/** Merge `patch` into the experiment's draft (the models by kind). */
export function updateTwinBuildDraft(expId: string, patch: TwinBuildDraft): void {
  try {
    const current = readTwinBuildDraft(expId);
    const next: TwinBuildDraft = { ...current, ...patch };
    if (patch.models) next.models = { ...current.models, ...patch.models };
    if (next.text !== undefined) next.text = next.text.slice(0, TWIN_INSTRUCTIONS_MAX);
    localStorage.setItem(draftKey(expId), JSON.stringify(next));
  } catch {
    // Not kept across a tab switch; the form still holds it.
  }
}

/** Drop the draft — the owner cancelled, or a twin was stored. A build passes the stamp the draft had when
 *  it started, and the draft goes only if it is still that one: another tab may have started a new request
 *  meanwhile, which a build it knows nothing of must not delete. */
export function clearTwinBuildDraft(expId: string, ifStamp?: string | null): void {
  try {
    if (ifStamp !== undefined && twinBuildDraftStamp(expId) !== ifStamp) return;
    localStorage.removeItem(draftKey(expId));
  } catch {
    // Nothing to do.
  }
}
