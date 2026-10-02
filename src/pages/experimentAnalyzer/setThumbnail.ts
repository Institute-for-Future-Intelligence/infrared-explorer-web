import { message } from 'antd';
import { forgetDownloadUrl } from '../../components/card/useDownloadUrl';
import { recordHistory, saveCustomThumbnail } from '../../services/experiments';
import useCommonStore from '../../stores/common';

const MESSAGE_KEY = 'set-thumbnail';

/**
 * "Set as thumbnail" (the player's right-click menu, owner only): make the player as displayed — the
 * current frame with its overlays — the picture the experiment's cards show. `capture` is the player's
 * own (the image player captures its wrapper directly; the video player may have to swap a cross-origin
 * <video> for a render of the frame) and resolves to a data URL.
 */
export async function setExperimentThumbnail(expId: string, capture: () => Promise<string>): Promise<void> {
  message.loading({ content: 'Saving thumbnail…', key: MESSAGE_KEY, duration: 0 });
  try {
    const dataURL = await capture();
    const path = await saveCustomThumbnail(expId, dataURL);
    const store = useCommonStore.getState();
    // The path is the same one every time (see saveCustomThumbnail), so what this session cached under
    // it is the previous picture: replace the thumbnail the cards read, drop the resolved download URL.
    store.setImageCache(path, dataURL);
    forgetDownloadUrl(path);
    const current = store.experimentMap.get(expId);
    if (current && current.thumbnailURL !== path) {
      // First custom thumbnail: the experiment still points at its default frame, and so does the
      // owner's own history row (written when the analyzer opened) — move both.
      const updated = { ...current, thumbnailURL: path };
      store.setExperiment(expId, updated);
      if (store.user) recordHistory(store.user, updated).catch((e) => console.error('failed to record history', e));
    }
    message.success({ content: 'Thumbnail updated', key: MESSAGE_KEY });
  } catch (e) {
    console.error('failed to set the thumbnail', e);
    message.error({ content: 'Couldn’t set the thumbnail.', key: MESSAGE_KEY });
  }
}
