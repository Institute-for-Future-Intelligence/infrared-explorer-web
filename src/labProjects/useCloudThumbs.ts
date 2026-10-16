/*
 * Each of a project's captures as the website can show it: the cloud copy's
 * thumbnail (experimentThumbs.ts) for a take that has one, and what to say
 * for one that has not. One map for the whole page: the Captures tab and
 * the capture chips in Discuss read the same states.
 */

import { useEffect, useState } from 'react';
import { readExperimentThumb, type ExperimentThumb } from './experimentThumbs';

export type CloudThumbState =
  /** The take has a copy in the cloud; its experiment is being read. */
  | { kind: 'loading' }
  | { kind: 'ready'; thumb: ExperimentThumb }
  /** The take has a copy in the cloud, but its experiment cannot be read (deleted, or private). */
  | { kind: 'unavailable' }
  /** The take has no copy in the cloud: it is on the owner's phone only. */
  | { kind: 'missing' };

/** The take's id and its cloud copy's experiment id, as the hook keys on them. */
export interface CloudTakeRef {
  takeId: string;
  cloud?: { expId: string } | null;
}

export function useCloudThumbs(takes: readonly CloudTakeRef[] | null | undefined): Map<string, CloudThumbState> {
  // Ids are the server's ([A-Za-z0-9_-]), so a joined key reads back unambiguously; keying the effect
  // on the string means a bundle reloaded with the same takes reads nothing again.
  const key = (takes ?? []).map((t) => `${t.takeId}:${t.cloud?.expId ?? ''}`).join(',');
  const [map, setMap] = useState<Map<string, CloudThumbState>>(() => new Map());
  useEffect(() => {
    const pairs = key
      ? key.split(',').map((s) => {
          const at = s.indexOf(':');
          return { takeId: s.slice(0, at), expId: s.slice(at + 1) };
        })
      : [];
    const next = new Map<string, CloudThumbState>();
    for (const p of pairs) {
      next.set(p.takeId, p.expId ? { kind: 'loading' } : { kind: 'missing' });
    }
    setMap(next);
    let alive = true;
    for (const p of pairs) {
      if (!p.expId) {
        continue;
      }
      readExperimentThumb(p.expId).then((thumb) => {
        if (!alive) {
          return;
        }
        setMap((prev) => {
          const m = new Map(prev);
          m.set(p.takeId, thumb ? { kind: 'ready', thumb } : { kind: 'unavailable' });
          return m;
        });
      });
    }
    return () => {
      alive = false;
    };
  }, [key]);
  return map;
}
