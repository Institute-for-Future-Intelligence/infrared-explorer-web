import { getBlob, ref } from 'firebase/storage';
import { useEffect, useState } from 'react';
import { firebaseStorage } from '../../services/firebase';
import useCommonStore from '../../stores/common';

/**
 * Load a thumbnail from its Firebase Storage path into a data URL, memoised in the shared
 * imageCache so a given thumbnail is fetched once across every card and list that shows it.
 * Returns null until the blob has been read, so callers can render a placeholder meanwhile.
 */
const useThumbnail = (url: string): string | null => {
  // Thumbnails are always read as data URLs (strings); the shared imageCache is typed to allow
  // ArrayBuffer, so the cast narrows it back to the string a callers's <img src> expects.
  const [dataURL, setDataURL] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    const cached = useCommonStore.getState().imageCache.get(url);
    if (cached) {
      setDataURL(cached as string);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const blob = await getBlob(ref(firebaseStorage, url));
        const reader = new FileReader();
        reader.onloadend = () => {
          const res = reader.result;
          if (res && !cancelled) {
            setDataURL(res as string);
            useCommonStore.getState().setImageCache(url, res);
          }
        };
        reader.readAsDataURL(blob);
      } catch (e) {
        // A missing/unreadable thumbnail just leaves the placeholder; nothing to recover.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return dataURL;
};

export default useThumbnail;
