/*
 * Full-size look at a project's pictures: the one clicked, and arrows (or
 * ←/→) through the others of the place it was opened from — Discuss, the
 * plan or the report, each in the order that tab shows them (core/
 * pictures.ts; Discuss's row also holds the photos the user's messages
 * carried, discussViewer.ts). The caption sits under the picture with its
 * place in the sequence. The same antd Modal shell as the analyzer's moment
 * lightbox.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Modal } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import type { ProjectImage } from '../core/types';
import { pictureCaption } from '../format';

const Stage = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;

  /*
   * The window keeps one size whatever picture is in it (user, 2026-11-10),
   * so the arrows stay under the pointer from one picture to the next: the
   * picture sits in a frame sized from the browser window alone, scaled to
   * fit it, and the caption has room for three lines whether it has one or
   * none (a longer one scrolls). The width leaves room for the two arrows and
   * the modal's own padding on a narrow window.
   */
  --lb-width: min(calc(92vw - 130px), 1100px);

  .lb-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* no fill of its own: where the picture does not reach, the window shows (user, 2026-11-10) */
  .lb-frame {
    width: var(--lb-width);
    height: min(72vh, calc(100vh - 260px));
  }
  .lb-frame img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .lb-caption {
    width: var(--lb-width);
    height: 4.5em;
    overflow-y: auto;
    text-align: center;
    font-size: 14px;
    line-height: 1.5;
    color: var(--ifi-ink);
  }
  .lb-count {
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
`;

/** What the viewer shows: a project picture, or (from Discuss) a capture's photo. */
export type LightboxPicture = Pick<ProjectImage, 'id' | 'url' | 'caption' | 'version'>;

const Lightbox = ({
  image,
  images,
  onClose,
}: {
  /** The picture to show; null = closed. */
  image: LightboxPicture | null;
  /** The pictures to page through, in order; the opened one is found in it (or shown alone). */
  images: LightboxPicture[];
  onClose: () => void;
}) => {
  const list = useMemo(() => (image && !images.some((i) => i.id === image.id) ? [image] : images), [image, images]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (image) {
      const at = list.findIndex((i) => i.id === image.id);
      setIndex(at < 0 ? 0 : at);
    }
  }, [image, list]);
  const step = (delta: number) => {
    if (list.length < 2) {
      return;
    }
    setIndex((i) => (i + delta + list.length) % list.length);
  };
  // ←/→ page; bound on window in the capture phase so a page under the modal does not also act on them
  useEffect(() => {
    if (!image) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, list.length]);

  const current = image ? (list[index] ?? image) : null;
  const caption = current ? pictureCaption(current).trim() : '';
  // room for a caption under every picture of a row in which any has one: the window does not jump between them
  const captioned = useMemo(() => list.some((p) => pictureCaption(p).trim() !== ''), [list]);
  return (
    <Modal
      open={!!current}
      onCancel={onClose}
      footer={null}
      centered
      width="auto"
      title={list.length > 1 ? `Picture ${index + 1} of ${list.length}` : 'Picture'}
      styles={{ body: { paddingTop: 8 } }}
    >
      {current && (
        <Stage>
          <div className="lb-row">
            {list.length > 1 && (
              <Button size="small" icon={<LeftOutlined />} title="Previous picture" onClick={() => step(-1)} />
            )}
            <div className="lb-frame">
              <img src={current.url} alt={current.caption || 'Picture'} />
            </div>
            {list.length > 1 && (
              <Button size="small" icon={<RightOutlined />} title="Next picture" onClick={() => step(1)} />
            )}
          </div>
          {captioned && <div className="lb-caption">{caption}</div>}
          {list.length > 1 && (
            <div className="lb-count">
              {index + 1} / {list.length}
            </div>
          )}
        </Stage>
      )}
    </Modal>
  );
};

export default Lightbox;
