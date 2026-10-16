/*
 * The Plan tab: the plan as it stands (only the current wording is kept),
 * with its pictures where the plan puts them — each the newest version of
 * that drawing — and the drawings the plan does not show after it. The
 * owner can edit it (PlanEditorModal), but not while the AI is working: it
 * may be rewriting the plan right then, and while it is, the text so far
 * shows as "Being written…". A shared page has no Edit Plan at all.
 */

import { useMemo } from 'react';
import { Button } from 'antd';
import { Pencil } from 'lucide-react';
import styled from 'styled-components';
import { picturesBesidePlan, withNewestPictures } from '../core/pictures';
import type { Project, ProjectImage } from '../core/types';
import { writtenWhen } from '../format';
import MarkdownView from '../MarkdownView';

const Wrap = styled.div`
  padding: 12px 18px 28px;

  .pt-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
    padding-bottom: 10px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--ifi-stroke-1);
  }
  .pt-meta b {
    font-weight: 500;
    color: var(--ifi-text-secondary);
  }
  .pt-meta-text {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    min-width: 0;
  }
  .pt-empty {
    padding: 36px 16px;
    text-align: center;
    color: var(--ifi-text-tertiary);
    font-size: 15px;
    line-height: 1.5;
  }
  .pt-others {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--ifi-stroke-1);
  }
  .pt-others-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ifi-ink);
    margin-bottom: 10px;
  }
  .pt-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
  }
  .pt-picture {
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    cursor: zoom-in;
    font: inherit;
  }
  .pt-picture img {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 2;
    object-fit: cover;
    border-radius: 8px;
    background: var(--ifi-fill-1);
  }
  .pt-picture span {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--ifi-text-tertiary);
  }
`;

const PlanTab = ({
  project,
  images,
  editorName,
  previewText = null,
  canEdit = false,
  readOnly = true,
  onOpenImage,
  onEdit,
}: {
  project: Pick<Project, 'plan' | 'chatModel'>;
  images: ProjectImage[];
  /** Who "Edited by" names: null on the owner's own page ("you"), the owner's name on a shared one. */
  editorName: string | null;
  /** The plan as the AI is writing it right now. */
  previewText?: string | null;
  /** False while the AI is working. */
  canEdit?: boolean;
  /** A viewer's page: no Edit Plan at all. */
  readOnly?: boolean;
  onOpenImage: (img: ProjectImage) => void;
  onEdit?: () => void;
}) => {
  const plan = project.plan;
  const writing = previewText != null;
  const text = writing ? previewText : (plan?.markdown ?? null);
  const shown = useMemo(() => (text != null ? withNewestPictures(text, images) : null), [text, images]);
  const others = useMemo(() => picturesBesidePlan(text, images), [text, images]);
  const model = project.chatModel?.label ?? null;
  const meta = writing
    ? 'Being written…'
    : plan
      ? `${plan.by === 'user' ? `Edited by ${editorName ?? 'you'}` : 'Written by the AI'} · ${writtenWhen(plan.at)}`
      : null;
  return (
    <Wrap>
      {(meta || model) && (
        <div className="pt-meta">
          <div className="pt-meta-text">
            {meta && <span>{meta}</span>}
            {model && (
              <span>
                Model: <b>{model}</b>
              </span>
            )}
          </div>
          {plan && !writing && !readOnly && (
            <Button type="link" size="small" icon={<Pencil size={14} />} disabled={!canEdit} onClick={onEdit}>
              Edit Plan
            </Button>
          )}
        </div>
      )}
      {shown != null ? (
        <MarkdownView markdown={shown} images={images} onOpenImage={onOpenImage} />
      ) : (
        <div className="pt-empty">
          {readOnly ? 'No plan yet.' : 'The plan appears here once you and the AI have worked one out in Discuss.'}
        </div>
      )}
      {others.length > 0 && (
        <div className="pt-others">
          <div className="pt-others-title">Other Pictures</div>
          <div className="pt-grid">
            {others.map((p) => (
              <button key={p.id} type="button" className="pt-picture" onClick={() => onOpenImage(p)}>
                <img src={p.url} alt={p.caption} loading="lazy" />
                <span>{p.caption}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Wrap>
  );
};

export default PlanTab;
