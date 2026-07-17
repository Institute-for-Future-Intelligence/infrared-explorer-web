import { getDownloadURL, ref } from 'firebase/storage';
import { useEffect, useState } from 'react';
import { firebaseStorage } from '../../services/firebase';

// Module-level cache so a given path resolves once across the session (survives remounts, unlike the
// per-component blob path).
const urlCache = new Map<string, string>();

/**
 * Resolve a Firebase Storage path to a direct download URL for `<img src>`. Unlike {@link useThumbnail}
 * (getBlob → FileReader → data URL, which blocks on JS + can't be browser/HTTP-cached and pins the
 * bytes in memory), this returns a plain https URL the browser can fetch, cache, and prioritise — the
 * right path for the hero's LCP image. Returns null until resolved.
 */
const useDownloadUrl = (path: string): string | null => {
  const [url, setUrl] = useState<string | null>(() => (path ? (urlCache.get(path) ?? null) : null));

  useEffect(() => {
    if (!path) return;
    const cached = urlCache.get(path);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    getDownloadURL(ref(firebaseStorage, path))
      .then((u) => {
        if (cancelled) return;
        urlCache.set(path, u);
        setUrl(u);
      })
      .catch(() => {
        // A missing/unreadable thumbnail just leaves the placeholder; nothing to recover.
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return url;
};

export default useDownloadUrl;
