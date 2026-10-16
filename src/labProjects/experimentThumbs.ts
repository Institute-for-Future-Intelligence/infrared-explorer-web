/*
 * What a project's capture looks like on the website: a take with a copy in
 * the cloud (`cloud.expId`) is an experiment, and its tile is that
 * experiment's thumbnail and title, read once from `experiments/{expId}` and
 * kept for the session. A take without a copy has nothing here: it is on the
 * owner's phone only.
 */

import { doc, getDoc } from 'firebase/firestore';
import { firebaseDatabase, firebaseStorage } from '../services/firebase';

export interface ExperimentThumb {
  expId: string;
  /** The experiment's displayName; empty when it has none. */
  title: string;
  /** An https URL an <img> loads, or null when the experiment has no thumbnail. */
  thumbnailUrl: string | null;
}

const cache = new Map<string, Promise<ExperimentThumb | null>>();

/**
 * The thumbnail as an https URL: the app writes one; the web's own uploads
 * may hold a bare Storage path or a gs:// URL, which live in our bucket
 * (whose thumbnail prefixes are public-read). Mirrors experimentThumbnail in
 * the app repository's functions/src/store.ts.
 */
export function thumbnailHttps(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) {
    return null;
  }
  if (/^https?:\/\//i.test(s)) {
    return s;
  }
  const gs = /^gs:\/\/([^/]+)\/(.+)$/i.exec(s);
  const bucket = gs ? gs[1] : firebaseStorage.app.options.storageBucket;
  if (!bucket) {
    return null;
  }
  const path = gs ? gs[2] : s.replace(/^\/+/, '');
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media`;
}

/** The experiment's thumbnail and title; null when it is gone or cannot be read. Read once per session. */
export function readExperimentThumb(expId: string): Promise<ExperimentThumb | null> {
  const hit = cache.get(expId);
  if (hit) {
    return hit;
  }
  const p = (async (): Promise<ExperimentThumb | null> => {
    try {
      const snap = await getDoc(doc(firebaseDatabase, 'experiments', expId));
      if (!snap.exists()) {
        return null;
      }
      const data = snap.data();
      const title = typeof data.displayName === 'string' ? data.displayName : '';
      return { expId, title, thumbnailUrl: thumbnailHttps(data.thumbnailURL) };
    } catch {
      return null;
    }
  })();
  cache.set(expId, p);
  // a failed read is not kept: the next look asks again
  p.then((v) => {
    if (v === null) {
      cache.delete(expId);
    }
  });
  return p;
}
