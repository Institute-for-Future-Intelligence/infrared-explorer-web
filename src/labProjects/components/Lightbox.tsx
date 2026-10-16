/*
 * Full-size look at a project's pictures: the one clicked, and arrows (or
 * ←/→) through the others of the place it was opened from — Discuss, the
 * plan or the report, each in the order that tab shows them (core/
 * pictures.ts). The caption sits under the picture with its place in the
 * sequence. The same antd Modal shell as the analyzer's moment lightbox.
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

  .lb-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  img {
    display: block;
    max-width: min(84vw, 1100px);
    max-height: 72vh;
    border-radius: 6px;
    background: var(--ifi-fill-1);
  }
  .lb-caption {
    max-width: min(84vw, 1100px);
    text-align: center;
    font-size: 14px;
    color: var(--ifi-ink);
  }
  .lb-count {
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    font-variant-numeric: tabular-nums;
  }
`;

const Lightbox = ({
  image,
  images,
  onClose,
}: {
  /** The picture to show; null = closed. */
  image: ProjectImage | null;
  /** The pictures to page through, in order; the opened one is found in it (or shown alone). */
  images: ProjectImage[];
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
            <img src={current.url} alt={current.caption || 'Picture'} />
            {list.length > 1 && (
              <Button size="small" icon={<RightOutlined />} title="Next picture" onClick={() => step(1)} />
            )}
          </div>
          {caption && <div className="lb-caption">{caption}</div>}
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
