/*
 * The report the AI wrote, as Discuss shows it: a page of a document — its
 * title and the start of the text, laid out as the report is — on a sheet
 * of paper over a strip naming it a report, when it was written, and Open.
 * The page shows as much as fits and fades out at the bottom. A click opens
 * the Report tab. The text is what that call wrote (a later report replaces
 * it in the tab, but each card keeps showing its own).
 */

import { useMemo } from 'react';
import { FileText } from 'lucide-react';
import styled from 'styled-components';
import { splitReportTitle } from '../core/markdown';
import type { ProjectImage } from '../core/types';
import MarkdownView from '../MarkdownView';

const PAPER = '#f7f5f0';
const PAGE_HEIGHT = 210;

const Card = styled.button`
  display: block;
  width: 72%;
  max-width: 320px;
  margin-top: 8px;
  padding: 0;
  border: 1px solid var(--ifi-stroke-1);
  border-radius: 12px;
  overflow: hidden;
  background: var(--ifi-panel);
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;

  .rc-desk {
    padding: 12px 12px 0;
    background: var(--ifi-fill-1);
  }
  .rc-paper {
    position: relative;
    height: ${PAGE_HEIGHT}px;
    overflow: hidden;
    padding: 12px 14px 0;
    background: ${PAPER};
    border-top-left-radius: 4px;
    box-shadow: 0 1px 3px rgba(11, 16, 38, 0.12);
    pointer-events: none;
  }
  .rc-title {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--ifi-ink);
    margin-right: 20px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rc-rule {
    width: 32px;
    height: 2px;
    background: var(--ifi-teal);
    margin: 7px 0 9px;
  }
  .rc-preview {
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--ifi-text-secondary);
  }
  .rc-preview figure img {
    max-height: 90px;
  }
  .rc-fade {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 48px;
    background: linear-gradient(to bottom, rgba(247, 245, 240, 0), ${PAPER});
  }
  .rc-corner {
    position: absolute;
    top: 0;
    right: 0;
    width: 0;
    height: 0;
    border-top: 20px solid var(--ifi-fill-1);
    border-left: 20px solid #e2ddd2;
  }
  .rc-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--ifi-text-secondary);
  }
  .rc-strip svg {
    color: var(--ifi-teal);
    flex: none;
  }
  .rc-strip-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rc-open {
    color: var(--ifi-teal-dark);
    font-weight: 600;
  }
  &:hover {
    border-color: var(--ifi-stroke-2);
  }
  &:focus-visible {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }
`;

const ReportCard = ({
  title,
  markdown,
  images,
  writtenAt,
  onOpen,
}: {
  title: string;
  markdown: string;
  images: ProjectImage[];
  /** When it was saved; null while it is still being written. */
  writtenAt: number | null;
  onOpen: () => void;
}) => {
  const parts = useMemo(() => splitReportTitle(title, markdown), [title, markdown]);
  const body = parts.body.trim();
  return (
    <Card type="button" onClick={onOpen} aria-label={`Report: ${parts.title}`}>
      <div className="rc-desk">
        <div className="rc-paper">
          <div className="rc-title">{parts.title}</div>
          <div className="rc-rule" />
          {body ? <MarkdownView className="rc-preview" markdown={body} images={images} compact /> : null}
          <div className="rc-fade" />
          <div className="rc-corner" />
        </div>
      </div>
      <div className="rc-strip">
        <FileText size={16} />
        <span className="rc-strip-text">
          {writtenAt != null ? `Report · ${new Date(writtenAt).toLocaleDateString()}` : 'Report · Writing…'}
        </span>
        {writtenAt != null && <span className="rc-open">Open ›</span>}
      </div>
    </Card>
  );
};

export default ReportCard;
