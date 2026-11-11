/*
 * The values the AI's code saves between runs (run_code's `save(name,
 * value)` / `load(name)`): kept in this browser with the project, per
 * account — the app keeps the same on the phone (lib/labProjects/
 * codeState.ts, AsyncStorage), and neither copy crosses devices. One run
 * can then build on what the last one worked out, the way a script reads
 * the file the one before it wrote. IndexedDB, one store, one record per
 * account and project; the 4 MB cap is the sandbox page's (SAVED_LIMIT).
 */

import type { Turn } from './core/types';

/** name → JSON */
export type CodeState = Record<string, string>;

const DB_NAME = 'labProjects';
const STORE = 'codeState';

const held = new Map<string, CodeState>();

const keyOf = (uid: string, projectId: string) => `${uid}:${projectId}`;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function request<T>(fn: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const tx = db.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
          tx.oncomplete = () => db.close();
          tx.onerror = () => db.close();
          tx.onabort = () => db.close();
        } catch {
          db.close();
          resolve(null);
        }
      }),
  );
}

/** What the project's code has saved in this browser; nothing when it saved nothing. */
export async function readCodeState(uid: string, projectId: string): Promise<CodeState> {
  const key = keyOf(uid, projectId);
  const hit = held.get(key);
  if (hit) {
    return hit;
  }
  const state: CodeState = {};
  try {
    const raw = await request<unknown>((s) => s.get(key), 'readonly');
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') {
          state[k] = v;
        }
      }
    }
  } catch {
    // an entry that cannot be read is nothing saved
  }
  const written = held.get(key);
  if (written) {
    return written;
  }
  held.set(key, state);
  return state;
}

export async function writeCodeState(uid: string, projectId: string, state: CodeState): Promise<void> {
  const key = keyOf(uid, projectId);
  held.set(key, state);
  try {
    if (Object.keys(state).length === 0) {
      await request((s) => s.delete(key), 'readwrite');
    } else {
      await request((s) => s.put(JSON.stringify(state), key), 'readwrite');
    }
  } catch {
    // kept in memory for this session at least
  }
}

/**
 * What the code had saved as of the conversation's last run: every run_code
 * result lists the saved names with their sizes (browserTools.ts `saved`, as
 * the app's runCode.ts), so the last one in `turns` is the state then —
 * nothing, when no run is among them. Undefined when that result cannot be
 * read (cut short on its way). The app's codeState.ts has the same.
 */
export function savedAsOf(turns: readonly Turn[]): Record<string, number> | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== 'tool' || t.name !== 'run_code') {
      continue;
    }
    try {
      const parsed = JSON.parse(t.result?.text ?? '') as { saved?: unknown } | null;
      const saved = parsed && typeof parsed === 'object' ? parsed.saved : null;
      const out: Record<string, number> = {};
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
          if (typeof v === 'number') {
            out[k] = v;
          }
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }
  return {};
}

/**
 * The conversation was cut back to `turns` (Delete from Here): the values the
 * code saved in the part that went go with it. A value stays when the last
 * run that is left lists it at the size it has now; one saved or rewritten
 * since does not.
 */
export async function rewindCodeState(uid: string, projectId: string, turns: readonly Turn[]): Promise<void> {
  const then = savedAsOf(turns);
  if (!then) {
    return;
  }
  const now = await readCodeState(uid, projectId);
  const kept: CodeState = {};
  for (const [name, json] of Object.entries(now)) {
    if (then[name] === json.length) {
      kept[name] = json;
    }
  }
  if (Object.keys(kept).length !== Object.keys(now).length) {
    await writeCodeState(uid, projectId, kept);
  }
}
