/*
 * Whether the signed-in user said they teach (users/{mongoId}.role, set from Settings › Classes
 * through the app's classroomSetRole callable). What shows "My Classes" in the sidebar and on
 * the Me hub (user 2026-11-02: nobody is a teacher until they said so). One read per account per
 * session, shared by every subscriber; the switch writes the new answer here as it saves, so the
 * sidebar follows it at once.
 */

import { useEffect, useState } from 'react';
import { fetchTeacherRole } from './classroomApi';

const known = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** The last answer for the account, or null when it has not been read yet. */
export function teacherRoleOf(uid: string | null | undefined): boolean | null {
  return uid ? (known.get(uid) ?? null) : null;
}

/** Read it once per account (later calls share the first read); the answer is cached. */
export function loadTeacherRole(uid: string): Promise<boolean> {
  const hit = known.get(uid);
  if (hit != null) return Promise.resolve(hit);
  let p = pending.get(uid);
  if (!p) {
    p = fetchTeacherRole(uid)
      .then((v) => {
        known.set(uid, v);
        notify();
        return v;
      })
      .finally(() => pending.delete(uid));
    pending.set(uid, p);
  }
  return p;
}

/** The switch saved a new answer. */
export function rememberTeacherRole(uid: string, teacher: boolean) {
  known.set(uid, teacher);
  notify();
}

/** False until the account's answer is known, true only for a self-declared teacher. */
export function useTeacherRole(uid: string | null | undefined): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    if (uid) loadTeacherRole(uid).catch(() => undefined);
    return () => {
      listeners.delete(l);
    };
  }, [uid]);
  return teacherRoleOf(uid) === true;
}
