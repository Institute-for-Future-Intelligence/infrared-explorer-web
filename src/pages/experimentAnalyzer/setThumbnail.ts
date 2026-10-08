import { message } from 'antd';
import { forgetDownloadUrl } from '../../components/card/useDownloadUrl';
import { recordHistory, saveCustomThumbnail } from '../../services/experiments';
import useCommonStore from '../../stores/common';
import { Presentation, SavedView, Thermometer } from '../../types';

const MESSAGE_KEY = 'set-thumbnail';

/**
 * "Set as thumbnail" (the player's right-click menu, owner only): make the player as displayed — the
 * current frame with its overlays — the picture the experiment's cards show, AND the view the experiment
 * opens on for visitors (ExperimentDoc.presentation): the same frame, the 3D surface and unit (`view`,
 * from the player), the charts and overlays, the chart appearance and image view, and the thermometers,
 * transects and notes as they stand right now, all read off the store. The owner's work goes on as the
 * working state after this; the pinned view holds until the next "Set as thumbnail". `capture` is the
 * player's own (the image player captures its wrapper directly; the video player may have to swap a
 * cross-origin <video> for a render of the frame) and resolves to a data URL.
 */
export async function setExperimentThumbnail(
  expId: string,
  capture: () => Promise<string>,
  view: Required<Pick<SavedView, 'frame' | 'surface3d' | 'unit'>>,
): Promise<void> {
  message.loading({ content: 'Saving thumbnail…', key: MESSAGE_KEY, duration: 0 });
  try {
    // Let the closing menu and the toast paint before the capture holds the main thread: html2canvas
    // clones the page synchronously, and the right-click menu would otherwise sit there unresponsive.
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const dataURL = await capture();
    const presentation = pinCurrentView(expId, view);
    const path = await saveCustomThumbnail(expId, dataURL, presentation);
    const store = useCommonStore.getState();
    // The path is the same one every time (see saveCustomThumbnail), so what this session cached under
    // it is the previous picture: replace the thumbnail the cards read, drop the resolved download URL.
    store.setImageCache(path, dataURL);
    forgetDownloadUrl(path);
    const current = store.experimentMap.get(expId);
    if (current) {
      // The experiment now carries the pinned view (the Info tab tells the owner when it was set); the
      // first custom thumbnail also moves it off its default frame — and so the owner's own history row
      // (written when the analyzer opened).
      const updated = { ...current, thumbnailURL: path, presentation };
      store.setExperiment(expId, updated);
      if (current.thumbnailURL !== path && store.user)
        recordHistory(store.user, updated).catch((e) => console.error('failed to record history', e));
    }
    message.success({ content: 'Thumbnail and opening view updated', key: MESSAGE_KEY });
  } catch (e) {
    console.error('failed to set the thumbnail', e);
    message.error({ content: 'Couldn’t set the thumbnail.', key: MESSAGE_KEY });
  }
}

// The analyzer as it stands, as a pinned opening view. Thermometers come from the store keyed by the
// experiment's live id list (minus the frame-dependent `value`), the notes from the mirror <Annotations>
// keeps in the store (empty until it has loaded — the owner can't right-click before the player is up).
const pinCurrentView = (expId: string, view: Required<Pick<SavedView, 'frame' | 'surface3d' | 'unit'>>) => {
  const store = useCommonStore.getState();
  const exp = store.experimentMap.get(expId);
  const thermometers = (exp?.thermometersId ?? [])
    .map((id) => store.thermometerMap.get(id))
    .filter((t): t is Thermometer => !!t)
    .map(({ value: _value, ...rest }) => rest);
  const presentation: Presentation = {
    setAt: Date.now(),
    frame: view.frame,
    surface3d: view.surface3d,
    unit: view.unit,
    graphsOptions: exp?.graphsOptions ?? [],
    chartSettings: exp?.chartSettings,
    profileLines: exp?.profileLines ?? [],
    thermometers,
    annotations: store.analyzerAnnotations.get(expId) ?? [],
  };
  return presentation;
};
