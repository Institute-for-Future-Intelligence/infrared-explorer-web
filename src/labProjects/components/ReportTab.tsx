/*
 * The Report tab: the report the AI wrote, whole, under its title, the time
 * it was written and the model that wrote it (and, once the owner has edited
 * it, Edited by). Pictures in it open full size; Edit (the owner's, not while
 * the AI works) rewrites it in the plan's editor, DocEditorModal;
 * Export as PDF prints the app's own white page (Save as PDF is the print
 * dialog's), Export as Text downloads the Markdown. While the AI is writing
 * it, the text so far. Until there is one, the owner's Generate Report
 * button asks the AI for it; the button is off while the AI has nothing to
 * write from (core/reportMaterial.ts) or is busy.
 */

import { useMemo, useState } from 'react';
import { Button, Spin, message } from 'antd';
import { FileDown, FileText, Pencil, Printer } from 'lucide-react';
import styled from 'styled-components';
import { splitReportTitle } from '../core/markdown';
import type { Project, ProjectImage } from '../core/types';
import { downloadReportText, printReport } from '../exportReport';
import { writtenWhen } from '../format';
import MarkdownView from '../MarkdownView';

const Wrap = styled.div`
  padding: 16px 18px 32px;

  .rt-title {
    font-size: 22px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--ifi-ink);
    margin: 0 0 6px;
  }
  .rt-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  .rt-meta {
    flex: 1;
    min-width: 180px;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ifi-text-tertiary);
  }
  .rt-meta b {
    font-weight: 500;
    color: var(--ifi-text-secondary);
  }
  .rt-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .rt-writing {
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    margin-bottom: 14px;
  }
`;

const Empty = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 48px 24px;
  text-align: center;
  color: var(--ifi-text-tertiary);
  font-size: 15px;
  line-height: 1.5;

  .rt-hint {
    font-size: 13px;
    margin-top: -4px;
  }
  .rt-working {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }
`;

const ReportTab = ({
  project,
  images,
  author,
  model,
  previewText = null,
  working = null,
  canGenerate = false,
  hasMaterial = false,
  readOnly = true,
  onOpenImage,
  onGenerate,
  onEdit,
}: {
  project: Pick<Project, 'report'>;
  images: ProjectImage[];
  /** Whose report it is on a shared page (what is exported names them, and "Edited by" too); null on the owner's own. */
  author: string | null;
  /** What the model that wrote the report is called (core/models reportModelName); null when not known. */
  model: string | null;
  /** The report as the AI is writing it right now. */
  previewText?: string | null;
  /** What the AI is doing on the way to a report the user asked for (before any text). */
  working?: string | null;
  /** False while the AI is busy: neither Generate Report nor Edit then. */
  canGenerate?: boolean;
  /** False while the AI has nothing to write from (hasReportMaterial). */
  hasMaterial?: boolean;
  /** A viewer's page: no Generate Report and no Edit at all. */
  readOnly?: boolean;
  onOpenImage: (img: ProjectImage) => void;
  onGenerate?: () => void;
  onEdit?: () => void;
}) => {
  const report = project.report;
  const parts = useMemo(() => (report ? splitReportTitle(report.title, report.markdown) : null), [report]);
  const [printing, setPrinting] = useState(false);
  if (previewText != null) {
    return (
      <Wrap>
        <div className="rt-writing">Being written…</div>
        <MarkdownView markdown={previewText} images={images} onOpenImage={onOpenImage} />
      </Wrap>
    );
  }
  if (!report || !parts) {
    if (readOnly) {
      return <Empty>No report yet.</Empty>;
    }
    if (working != null) {
      return (
        <Empty>
          <div className="rt-working">
            <Spin size="small" />
            <span>{working}</span>
          </div>
        </Empty>
      );
    }
    const off = !canGenerate || !hasMaterial;
    return (
      <Empty>
        <div>
          There is no report yet. When the experiment is done, the AI writes one from the conversation and the captures.
        </div>
        <Button type="primary" shape="round" icon={<FileText size={16} />} disabled={off} onClick={onGenerate}>
          Generate Report
        </Button>
        {!canGenerate ? (
          <div className="rt-hint">The AI is busy. Wait for it to finish.</div>
        ) : !hasMaterial ? (
          <div className="rt-hint">
            The AI has nothing to write from yet. Send it a message or a capture in Discuss first.
          </div>
        ) : null}
      </Empty>
    );
  }
  const written = writtenWhen(report.at);
  const meta = [author, written, model ? `Model: ${model}` : null].filter(Boolean).join(' · ');
  const input = { title: parts.title, meta, body: parts.body, images };
  const onPrint = async () => {
    setPrinting(true);
    try {
      await printReport(input);
    } catch {
      message.error('Could not open the print dialog.');
    } finally {
      setPrinting(false);
    }
  };
  return (
    <Wrap>
      <h1 className="rt-title">{parts.title}</h1>
      <div className="rt-head">
        <div className="rt-meta">
          <div>Written {written}</div>
          {model && (
            <div>
              Model: <b>{model}</b>
            </div>
          )}
          {report.by === 'user' && <div>Edited by {author ?? 'you'}</div>}
        </div>
        <div className="rt-actions">
          {!readOnly && (
            <Button icon={<Pencil size={15} />} disabled={!canGenerate} onClick={onEdit}>
              Edit
            </Button>
          )}
          <Button icon={<Printer size={15} />} loading={printing} onClick={onPrint}>
            Export as PDF
          </Button>
          <Button icon={<FileDown size={15} />} onClick={() => downloadReportText(input)}>
            Export as Text
          </Button>
        </div>
      </div>
      <MarkdownView markdown={parts.body} images={images} onOpenImage={onOpenImage} />
    </Wrap>
  );
};

export default ReportTab;
