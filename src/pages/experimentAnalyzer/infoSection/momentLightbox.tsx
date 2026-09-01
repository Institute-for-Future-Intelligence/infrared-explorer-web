import React, { useEffect, useRef, useState } from 'react';
import { Button, Modal, Segmented, Spin, message } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, ExperimentType, ViewMode } from '../../../types';
import { formatDuration } from '../../../utils/helpers';
import { useMappingIndex } from '../hooks';
import { fetchRecordingFrameDataUrl } from '../../../utils/recordingFrame';
import { getMetadata, ref } from 'firebase/storage';
import { firebaseStorage } from '../../../services/firebase';

// The lightbox view switcher. Same three renders the player cycles through, in the same order; only a
// recording that uploaded the vis/mix companions offers them (see viewModesAvailable below).
const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'ir', label: 'Infrared' },
  { value: 'visible', label: 'Visible' },
  { value: 'blended', label: 'Blended' },
];

// One page of the lightbox: the frame image plus what the pager and the seek button need. `label` is the
// page's badge (①②③ for Q&A moments, 1/2/3 for report figures), taken from its place in the FULL group
// so a page whose image is still rebuilding doesn't renumber the ones around it.
export interface PreviewItem {
  src: string;
  recordingIndex: number;
  tSeconds: number;
  label: string;
}

// The blown-up frame, shown in a Modal — which portals OUT of the host panel, so it carries its own
// styles. A thermal frame is only 120x160 real pixels, so the image is capped well short of the
// viewport: scaling it further only magnifies the interpolation.
const Lightbox = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;

  /* The frame flanked by its pager arrows (they only render when the group holds more than one). The
     image is capped narrow enough that both arrows still fit beside it on a phone-width viewport. */
  .lb-stage {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* The box carries the size caps and the FRAME'S OWN ASPECT (set inline once the image reports its
     natural size), and the image fills it exactly. Sizing the box by shrink-to-fit around the image does
     not work: max-height scales a portrait frame down without narrowing the box that wraps it, and an
     overlay filling that box then draws its markers wider than the picture. With the ratio on the box,
     the image and any overlay share one geometry by construction. */
  .lb-frame {
    position: relative;
    display: block;
    /* Width only — the height follows from the aspect the inline style sets, and the height cap is
       folded INTO that width (see the style prop). Leaving the cap as a max-height would let the box
       clamp its height without narrowing: aspect-ratio is a preference, not a constraint that reverses,
       so the image inside would be squashed rather than fitted. */
    width: min(64vw, 380px);
    min-width: 0;
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 6px;
    background: #f5f5f5;
    transition: opacity 0.15s ease;
  }
  /* Until the first image reports its size there is no ratio to hold, so the image sizes itself. */
  .lb-frame.no-aspect {
    width: auto;
    height: auto;
  }
  .lb-frame.no-aspect img {
    width: auto;
    height: auto;
    max-width: min(64vw, 380px);
    max-height: 66vh;
  }
  /* While another render of the same frame is downloading, the current one stays put and dims — so the
     modal never collapses to a spinner and jumps back. */
  .lb-frame.is-loading img {
    opacity: 0.45;
  }
  .lb-spin {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
`;

interface Props {
  experiment: Experiment;
  /** The open group and page (null = closed). Owned by the host panel so it decides what forms a group. */
  preview: { items: PreviewItem[]; index: number } | null;
  /** Page by +1/-1; the host wraps at the ends (a group is small, so wrapping beats dead arrows). */
  onStep: (delta: number) => void;
  onClose: () => void;
  /** Jump the player to this frame. recordingIndex is passed back untranslated — the host knows whether
   *  it is a recording-frame number (map via getPlayerIndex) or a video's .vir index (use as is). */
  onSeek: (recordingIndex: number) => void;
  /** What a page is called in the title: "Moment" (Q&A) or "Figure" (report). */
  kindLabel?: string;
  /** Drawn over the enlarged frame — the report passes its probe/annotation overlay so a figure shown
   *  full size carries the same markers it does inline. Rendered inside the (relative) frame box, so it
   *  positions against the image itself and not the modal. */
  renderOverlay?: (item: PreviewItem) => React.ReactNode;
}

/**
 * The moment lightbox, extracted from the Q&A panel so the AI report's figures can share it: pages
 * through one group of frames with wrapping arrows/←/→, flips a recording's frame between its
 * IR/visible/blended renders, and offers an explicit "Jump to t" that closes first so the player it
 * seeks is actually visible. Keep it MOUNTED (open is driven by `preview`) — the per-mode render cache
 * and the one-shot companion probe live here and are meant to survive open/close cycles.
 */
const MomentLightbox = ({
  experiment,
  preview,
  onStep,
  onClose,
  onSeek,
  kindLabel = 'Moment',
  renderOverlay,
}: Props) => {
  const isVideo = experiment.sourceType === ExperimentType.Video;
  const { getRecordingIndex } = useMappingIndex(experiment.segments, experiment.duration);

  // Which render the lightbox shows. Sticky across paging (switch to Visible, page on, stay on Visible)
  // and reset to IR on close, since IR is the only render every recording is guaranteed to have.
  const [previewMode, setPreviewMode] = useState<ViewMode>('ir');
  // Renders fetched for the lightbox, keyed `<mode>:<recordingIndex>`. A moment carries only the frame
  // its chip was snapshotted from, so every other render is a Storage fetch — cached here so paging back
  // and forth (or flipping IR/Visible/Blended) re-downloads nothing.
  const [previewRenders, setPreviewRenders] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  // Whether this recording uploaded the vis/mix companions, probed once the first time the lightbox
  // opens (null = not probed yet). Mirrors ImagePlayer's own probe: a legacy telelab recording has only
  // data_N.png, and then the switcher never appears. Videos never have per-frame renders at all.
  const [viewModesAvailable, setViewModesAvailable] = useState<boolean | null>(null);
  // The frame's natural width/height ratio, learned from the first image that loads. Every render of a
  // given clip shares it, so paging or switching IR/visible/blended keeps the box the same shape.
  const [frameAspect, setFrameAspect] = useState<number | null>(null);

  // Closing resets the switcher: IR is the one render every recording has, so the next open never
  // starts on a mode the shown moment might not have.
  useEffect(() => {
    if (!preview) setPreviewMode('ir');
  }, [preview]);

  // One-shot probe for the vis/mix companions, deferred until the lightbox is first opened so an analyzer
  // visit that never opens one costs no Storage request. Frame numbers are recording indices, so it probes
  // the clip's first mapped frame — exactly what ImagePlayer does for its own view-mode button.
  const viewProbedRef = useRef(false);
  useEffect(() => {
    if (!preview || viewProbedRef.current) return;
    viewProbedRef.current = true;
    if (isVideo || !experiment.recordingId) {
      setViewModesAvailable(false);
      return;
    }
    let cancelled = false;
    getMetadata(ref(firebaseStorage, `recordings/${experiment.recordingId}/vis_${getRecordingIndex(0)}.jpg`))
      .then(() => !cancelled && setViewModesAvailable(true))
      .catch(() => !cancelled && setViewModesAvailable(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // Fetch the render the lightbox is asking for. A moment carries only the snapshot its chip was taken
  // from — in whichever mode the player happened to be showing — so once the switcher is available every
  // render is fetched by mode instead, keeping the picture and the switcher's label in step.
  useEffect(() => {
    const item = preview ? preview.items[preview.index] : null;
    const recordingId = experiment.recordingId;
    const key = item ? `${previewMode}:${item.recordingIndex}` : null;
    if (!item || !key || isVideo || !recordingId || !viewModesAvailable || previewRenders[key] !== undefined) {
      // Nothing to fetch — already cached, or this experiment has no per-mode renders. Clear the spinner
      // explicitly: paging off a still-downloading frame onto a cached one cancels that fetch, and its
      // own finally() is skipped, so without this the dimmed-and-spinning state would stick.
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    fetchRecordingFrameDataUrl(recordingId, item.recordingIndex, previewMode)
      .then((url) => !cancelled && setPreviewRenders((r) => ({ ...r, [key]: url })))
      .catch(() => {
        if (cancelled) return;
        // The recorder skips a still now and then, so a frame can be missing one companion while the
        // clip as a whole has them. Say so and drop back to IR rather than leaving the switcher pointing
        // at a picture that never arrives.
        message.info(`This frame has no ${previewMode === 'visible' ? 'visible-light' : 'blended'} still.`);
        setPreviewMode('ir');
      })
      .finally(() => !cancelled && setPreviewLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, previewMode, previewRenders, viewModesAvailable]);

  // Arrow keys page the open lightbox (Esc is antd’s). Bound on window because the Modal parks focus on
  // its close button, so a handler on the content would miss until the user clicked inside first — and in
  // the CAPTURE phase with propagation stopped, because the player binds ←/→ to frame-stepping on window
  // too (see ImagePlayer). Capture runs before those bubble-phase listeners, so the frame stays put while
  // the lightbox is up.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      onStep(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [preview, onStep]);

  // The page on screen (null = closed), and the picture for it: the render fetched for the selected mode
  // when there is one, else the moment's own snapshot — which covers a video, a legacy recording with no
  // companions, and the first paint while the IR render is still downloading.
  const previewItem = preview ? preview.items[preview.index] : null;
  const previewSrc = previewItem
    ? (previewRenders[`${previewMode}:${previewItem.recordingIndex}`] ?? previewItem.src)
    : null;
  const canSwitchViews = !isVideo && viewModesAvailable === true;

  return (
    /* The enlarged frame. Seeking to the moment lives here (not on the thumbnail's click): the button
       closes the lightbox first, so the player it jumps to is actually visible. With more than one frame
       in the group, the arrows beside the picture (or ←/→) page through them in place; on a recording
       that uploaded them, the switcher flips the same frame between its three renders. */
    <Modal
      open={!!previewItem}
      onCancel={onClose}
      footer={null}
      centered
      width="auto"
      title={previewItem ? `${kindLabel} ${previewItem.label} at ${formatDuration(previewItem.tSeconds)}` : undefined}
      styles={{ body: { paddingTop: 8 } }}
    >
      {previewItem && preview && (
        <Lightbox>
          <div className="lb-stage">
            {preview.items.length > 1 && (
              <Button
                size="small"
                icon={<LeftOutlined />}
                title={`Previous ${kindLabel.toLowerCase()}`}
                onClick={() => onStep(-1)}
              />
            )}
            <div
              className={`lb-frame${previewLoading ? ' is-loading' : ''}${frameAspect ? '' : ' no-aspect'}`}
              style={
                frameAspect
                  ? {
                      aspectRatio: String(frameAspect),
                      // The third term is the height cap expressed as a width: height = width / aspect,
                      // so width <= 66vh * aspect keeps a tall frame inside 66vh with its ratio intact.
                      width: `min(64vw, 380px, ${(66 * frameAspect).toFixed(3)}vh)`,
                    }
                  : undefined
              }
            >
              <img
                src={previewSrc ?? undefined}
                alt={`Frame at ${formatDuration(previewItem.tSeconds)}`}
                // Both paths matter: a frame fetched now fires load, while the thumbnail's data URL is
                // often already decoded when the element mounts — that image never fires load, and
                // without the ref check the box would keep sizing itself for a frame of unknown shape.
                ref={(el) => {
                  if (el?.complete && el.naturalWidth > 0 && el.naturalHeight > 0) {
                    setFrameAspect(el.naturalWidth / el.naturalHeight);
                  }
                }}
                onLoad={(e) => {
                  const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                  if (w > 0 && h > 0) setFrameAspect(w / h);
                }}
              />
              {renderOverlay?.(previewItem)}
              {previewLoading && (
                <span className="lb-spin">
                  <Spin size="small" />
                </span>
              )}
            </div>
            {preview.items.length > 1 && (
              <Button
                size="small"
                icon={<RightOutlined />}
                title={`Next ${kindLabel.toLowerCase()}`}
                onClick={() => onStep(1)}
              />
            )}
          </div>
          {canSwitchViews && (
            <Segmented
              size="small"
              value={previewMode}
              onChange={(v) => setPreviewMode(v as ViewMode)}
              options={VIEW_MODE_OPTIONS}
            />
          )}
          <Button
            size="small"
            onClick={() => {
              onSeek(previewItem.recordingIndex);
              onClose();
            }}
          >
            Jump to {formatDuration(previewItem.tSeconds)}
          </Button>
        </Lightbox>
      )}
    </Modal>
  );
};

export default MomentLightbox;
