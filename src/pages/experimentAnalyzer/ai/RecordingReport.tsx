/*
 * The analyzer's AI Report tab on the app's AI flow (docs/analyzer-ai-app-flow-plan.md). The report is
 * the experiment's — written by the owner's Generate / Revise / Rewrite run (a conversation of its own,
 * decision A, shown here while it runs), kept on the experiment document and in labReports/{id} with the
 * pictures it embeds, and read by every viewer. The owner may also edit it by hand (decision G); the next
 * Revise run reads the edit. An older report (the previous engine) still shows: its [figure] markers
 * become a line of text (decision D).
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Empty, Input, Popconfirm, Select, message } from 'antd';
import {
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileTextOutlined,
  PrinterOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import styled from 'styled-components';
import { Experiment, MODEL_KEYS, MODEL_LABELS, currentModelKey, modelLabel, type QaModel } from '../../../types';
import useCommonStore from '../../../stores/common';
import { isStaff } from '../../../utils/staff';
import ConsentDialog from '../../../labProjects/components/ConsentDialog';
import DocEditorModal from '../../../labProjects/components/DocEditorModal';
import Lightbox from '../../../labProjects/components/Lightbox';
import { providerNameFor } from '../../../labProjects/consent';
import { reportEditorText, splitReportTitle } from '../../../labProjects/core/markdown';
import type { ProjectImage } from '../../../labProjects/core/types';
import { printReport } from '../../../labProjects/exportReport';
import MarkdownView from '../../../labProjects/MarkdownView';
import {
  clearLabReport,
  editLabReport,
  fetchLabReport,
  recordAiConsent,
  type LabReportMeta,
  type RecImage,
  type ReportImageRef,
} from '../../../services/recordingAi';
import Conversation from './RecordingReplies';
import {
  aiSupports,
  dismissConsent,
  pendingBrowserCalls,
  resendAfterConsent,
  resumePending,
  retryReportRun,
  startReportRun,
  stopReportRun,
  useRunView,
} from './recordingAiRunner';

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 14px;
  color: var(--ifi-ink);

  /* One row at every width (the workspace can be squeezed to ~350px beside a wide clip): the model
     picker gives way first, then the buttons shed their words against the row's own width (a
     container query — the viewport can't see the workspace). A shed word stays the button's
     accessible name (visually hidden, not removed) and its title. */
  .rr-toolbar {
    container: rr-toolbar / inline-size;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-bottom: 10px;
  }
  .rr-toolbar > * {
    flex: none;
  }
  /* antd's Dropdown.Button is a block Space.Compact (width: 100%), which took the whole row — the
     other buttons were pushed out of the panel. As wide as its two buttons. */
  .rr-toolbar .rr-revise {
    width: auto;
  }
  .rr-toolbar .rr-model {
    flex: 0 1 172px;
    min-width: 80px;
  }
  @container rr-toolbar (max-width: 620px) {
    .rr-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  }
  @container rr-toolbar (max-width: 400px) {
    .rr-wide {
      display: none;
    }
  }
  @container rr-toolbar (max-width: 360px) {
    .rr-label-xs {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
  }
  .rr-divider {
    width: 1px;
    align-self: stretch;
    min-height: 18px;
    background: var(--ifi-stroke-1);
    margin: 0 2px;
  }
  /* Export and Clear, the report's own actions, sit at the row's end */
  .rr-end {
    margin-left: auto;
  }
  .rr-notes-hint {
    font-size: 11px;
    color: var(--ifi-text-tertiary);
    margin-top: 4px;
  }
  .rr-status {
    font-size: 12px;
    color: var(--ifi-text-secondary);
    margin-bottom: 8px;
  }
  .rr-error {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    font-size: 12.5px;
    color: var(--ifi-danger);
    margin-bottom: 8px;
  }
  .rr-progress {
    border: 1px solid var(--ifi-stroke-1);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 10px;
    background: var(--ifi-fill-1);
  }
  .rr-progress-head {
    font-size: 12px;
    font-weight: 600;
    color: var(--ifi-text-secondary);
    margin-bottom: 8px;
  }
  .rr-body {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding-right: 4px;
  }
  .rr-title {
    font-size: 21px;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.01em;
    margin: 2px 0 6px;
  }
  .rr-meta {
    font-size: 12px;
    color: var(--ifi-text-tertiary);
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--ifi-stroke-1);
  }
  .rr-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .rr-export {
    flex: none;
    margin: -4px 0;
    color: var(--ifi-text-secondary);
  }
  .rr-legacy {
    font-size: 12px;
    color: #874d00;
    background: #fff7e6;
    border: 1px solid #ffe7ba;
    border-radius: 4px;
    padding: 4px 8px;
    margin-bottom: 8px;
  }
  .rr-unavailable {
    color: var(--ifi-text-tertiary);
    font-size: 12.5px;
    line-height: 1.5;
    margin-bottom: 10px;
  }
`;

/** Server-side cap on the owner's notes (functions/src/recordingAi/config.ts REPORT_NOTES_MAX), mirrored. */
const NOTES_MAX = 1000;
const notesKey = (expId: string) => `report-instructions:${expId}`;

/** A saved report's pictures, as MarkdownView resolves ![caption](image:ID). */
const toPictures = (refs: ReportImageRef[]): ProjectImage[] =>
  refs.map((r) => ({ id: r.id, kind: 'look', path: r.path, mime: r.mime, caption: r.caption, url: r.url, at: 0 }));

/**
 * A report of the previous engine names its figures with [figure: t = N s | caption] lines, which that
 * engine's page turned into frame images. They are a line of text here (decision D).
 */
const LEGACY_FIGURE = /^\s*\[figure:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\s*$/gm;
const legacyFiguresAsText = (md: string): string =>
  md.replace(
    LEGACY_FIGURE,
    (_m, at: string, caption?: string) => `*Figure — ${at.trim()}${caption?.trim() ? `: ${caption.trim()}` : ''}*`,
  );
const hasLegacyFigures = (md: string): boolean => /\[figure:/.test(md);

const UNAVAILABLE =
  'AI analysis isn’t available for this clip. It is an older showcase video stored as one .vir file, and the AI’s tools read a recording frame by frame in your browser, which that format doesn’t support. Recordings captured with the app and photo sets are supported.';

const RecordingReport = ({ experiment }: { experiment: Experiment }) => {
  const expId = experiment.id;
  const user = useCommonStore((s) => s.user);
  const isOwner = !!user && user.id === experiment.ownerId;
  const supported = aiSupports(experiment);
  const run = useRunView(expId);
  const running = run?.running ?? false;

  const report = experiment.aiReport ?? '';
  const [meta, setMeta] = useState<LabReportMeta | null>(null);
  useEffect(() => {
    let alive = true;
    if (!experiment.labReportId || !report) {
      setMeta(null);
      return;
    }
    fetchLabReport(experiment.labReportId).then((m) => {
      if (alive) setMeta(m);
    });
    return () => {
      alive = false;
    };
  }, [experiment.labReportId, report]);

  // the model for the NEXT run, remembered across sessions (a retired key carries over to its successor)
  const [model, setModelState] = useState<QaModel>(
    () => currentModelKey(localStorage.getItem('report-model')) ?? 'gpt6luna',
  );
  const setModel = (m: QaModel) => {
    setModelState(m);
    localStorage.setItem('report-model', m);
  };
  // the owner's notes for the next run, drafted per recording
  const [notes, setNotesState] = useState(() => localStorage.getItem(notesKey(expId)) ?? '');
  const [notesOpen, setNotesOpen] = useState(false);
  const setNotes = (v: string) => {
    const next = v.slice(0, NOTES_MAX);
    setNotesState(next);
    if (next) localStorage.setItem(notesKey(expId), next);
    else localStorage.removeItem(notesKey(expId));
  };
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [lightbox, setLightbox] = useState<{ image: ProjectImage; images: ProjectImage[] } | null>(null);

  // a run a dropped connection left waiting for the browser carries on
  useEffect(() => {
    if (isOwner && run && !run.running && !run.finished && pendingBrowserCalls(run.turns).length > 0) {
      void resumePending(experiment, 'report');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expId]);

  const pictures = useMemo(() => toPictures(meta?.images ?? []), [meta]);
  const parts = useMemo(() => (report ? splitReportTitle(meta?.title ?? '', report) : null), [report, meta?.title]);
  const legacy = !!report && (meta?.legacy ?? true) && hasLegacyFigures(report);
  const body = useMemo(() => (parts ? (legacy ? legacyFiguresAsText(parts.body) : parts.body) : ''), [parts, legacy]);

  const start = (mode: 'revise' | 'rewrite') => {
    if (running) return;
    startReportRun(experiment, mode, notes.trim(), model).catch((e) => console.error('report run failed', e));
  };

  const onClear = async () => {
    setClearing(true);
    try {
      await clearLabReport(expId);
      const store = useCommonStore.getState();
      const exp = store.experimentMap.get(expId);
      if (exp) {
        const cleared = { ...exp };
        delete cleared.aiReport;
        delete cleared.aiReportModel;
        delete cleared.aiReportAt;
        delete cleared.aiReportInstructions;
        delete cleared.aiReportInputsHash;
        delete cleared.aiReportInputs;
        delete cleared.aiReportVerified;
        delete cleared.aiReportVision;
        delete cleared.aiReportSampling;
        delete cleared.labReportId;
        store.setExperiment(expId, cleared);
      }
      message.success('Report cleared.');
    } catch (e) {
      message.error((e as Error)?.message || 'Could not clear the report.');
    } finally {
      setClearing(false);
    }
  };

  const onPrint = async () => {
    if (!parts) return;
    setPrinting(true);
    try {
      const modelName = experiment.aiReportModel ? modelLabel(experiment.aiReportModel) : null;
      await printReport({
        title: parts.title || experiment.displayName || 'Report',
        meta: [modelName ? `Model: ${modelName}` : null, meta?.editedBy === 'user' ? 'Edited by the author' : null]
          .filter(Boolean)
          .join(' · '),
        body,
        images: pictures,
      });
    } catch {
      message.error('Could not open the print dialog.');
    } finally {
      setPrinting(false);
    }
  };

  const onSaveEdit = async (md: string) => {
    const split = splitReportTitle(parts?.title ?? '', md);
    const bodyText = split.body.replace(/^\s+/, '');
    await editLabReport(expId, split.title, bodyText);
    const store = useCommonStore.getState();
    const exp = store.experimentMap.get(expId);
    if (exp) store.setExperiment(expId, { ...exp, aiReport: bodyText });
    setMeta((m) => (m ? { ...m, title: split.title, editedBy: 'user' } : m));
    setEditing(false);
  };

  const openPicture = (i: RecImage) => setLightbox({ image: i, images: run?.images ?? pictures });
  const showProgress =
    !!run && (run.running || (!run.finished && run.turns.length > 0) || (!!run.error && !run.finished));
  const modelName = experiment.aiReportModel ? modelLabel(experiment.aiReportModel) : null;

  return (
    <Wrap>
      {!supported && <div className="rr-unavailable">{UNAVAILABLE}</div>}
      {isOwner && supported && (
        <div className="rr-toolbar">
          {!report ? (
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              loading={running}
              disabled={running}
              onClick={() => start('rewrite')}
            >
              <span>
                Generate<span className="rr-wide"> report</span>
              </span>
            </Button>
          ) : (
            <Dropdown.Button
              size="small"
              className="rr-revise"
              disabled={running}
              onClick={() => start('revise')}
              icon={<DownOutlined />}
              menu={{
                items: [
                  {
                    key: 'rewrite',
                    label: 'Rewrite from scratch',
                    onClick: () => start('rewrite'),
                  },
                ],
              }}
              title="Ask the AI to revise the current report — it reads the report as it is (your edits too) and your notes"
            >
              <ThunderboltOutlined />
              <span className="rr-label-xs">
                Revise<span className="rr-wide"> with AI</span>
              </span>
            </Dropdown.Button>
          )}
          {running && (
            <Button
              size="small"
              danger
              onClick={() => stopReportRun(expId)}
              title="Stop — the model stops too; the saved report stays"
            >
              Stop
            </Button>
          )}
          {report && !running && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => setEditing(true)}
              title="Edit the report yourself"
            >
              <span className="rr-label">Edit</span>
            </Button>
          )}
          <span className="rr-divider" aria-hidden="true" />
          <Select
            size="small"
            value={model}
            onChange={setModel}
            disabled={running}
            className="rr-model"
            aria-label="Model for the next run"
            title="Model for the next run"
            options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
          />
          <Button
            size="small"
            type={notesOpen ? 'default' : 'text'}
            icon={<FileTextOutlined />}
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            title="Notes for the AI: what to focus on, what to change, or setup details the data can't show"
          >
            <span className="rr-label">Notes</span>
            {notes.trim() ? <span aria-label="(has notes)">•</span> : null}
          </Button>
          {report && parts && !running && (
            <Button
              size="small"
              type="text"
              icon={<PrinterOutlined />}
              loading={printing}
              onClick={onPrint}
              className="rr-end"
              title="Print the report or save it as a PDF"
            >
              <span className="rr-label">Export</span>
            </Button>
          )}
          {report && !running && (
            <Popconfirm
              title="Clear this report?"
              description="The saved report and its pictures are deleted for everyone. This can't be undone."
              okText="Clear"
              okButtonProps={{ danger: true, loading: clearing }}
              onConfirm={onClear}
            >
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                loading={clearing}
                title="Delete the saved report"
              >
                <span className="rr-label">Clear</span>
              </Button>
            </Popconfirm>
          )}
        </div>
      )}
      {isOwner && supported && notesOpen && (
        <div style={{ marginBottom: 10 }}>
          <Input.TextArea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={running}
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={NOTES_MAX}
            placeholder={
              'Optional. Tell the AI what to focus on or what to change — e.g. "the left mug held 80 °C water, the right one 40 °C" or "shorten the conclusion and explain the cooling rate".'
            }
            aria-label="Notes for the AI report"
          />
          <div className="rr-notes-hint">Saved with the report so readers can see what the AI was told.</div>
        </div>
      )}
      {showProgress && run && (
        <div className="rr-progress">
          <div className="rr-progress-head">
            {run.running ? 'Writing the report…' : run.error ? 'The run stopped' : 'Waiting to continue'}
          </div>
          <Conversation
            turns={run.turns}
            images={run.images}
            model={run.model}
            live={{ running: run.running, liveText: run.liveText, status: run.status, preview: run.preview }}
            showFailures={isStaff(user)}
            onOpenImage={openPicture}
          />
          {run.error && !run.running && (
            <div className="rr-error" style={{ marginTop: 8 }}>
              <span>{run.error}</span>
              {run.canRetry && (
                <Button size="small" onClick={() => retryReportRun(experiment)}>
                  Try Again
                </Button>
              )}
            </div>
          )}
          {!run.running && !run.error && pendingBrowserCalls(run.turns).length > 0 && (
            <div className="rr-error" style={{ marginTop: 8, color: 'var(--ifi-text-tertiary)' }}>
              <span>The AI was waiting for your browser when the page closed.</span>
              <Button size="small" onClick={() => resumePending(experiment, 'report')}>
                Continue
              </Button>
            </div>
          )}
        </div>
      )}
      {report && parts ? (
        <div className="rr-body">
          {parts.title && <h1 className="rr-title">{parts.title}</h1>}
          <div className="rr-meta">
            <div className="rr-meta-row">
              <span>
                {[
                  modelName ? `Generated by ${modelName}` : 'AI-generated',
                  meta?.editedBy === 'user' ? (isOwner ? 'Edited by you' : 'Edited by the author') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {!(isOwner && supported) && (
                <Button
                  size="small"
                  type="text"
                  icon={<PrinterOutlined />}
                  loading={printing}
                  onClick={onPrint}
                  className="rr-export"
                  title="Print the report or save it as a PDF"
                >
                  Export
                </Button>
              )}
            </div>
            {experiment.aiReportInstructions ? (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer' }}>Written with notes from the author</summary>
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    marginTop: 4,
                    paddingLeft: 8,
                    borderLeft: '2px solid var(--ifi-stroke-1)',
                  }}
                >
                  {experiment.aiReportInstructions}
                </div>
              </details>
            ) : null}
          </div>
          {legacy && isOwner && supported && (
            <div className="rr-legacy">
              This report was written by the previous AI. Rewrite it from scratch for one with pictures.
            </div>
          )}
          <MarkdownView markdown={body} images={pictures} onOpenImage={openPicture} />
        </div>
      ) : (
        !showProgress && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={isOwner && supported ? 'No report yet — click Generate report above.' : 'No AI report yet.'}
          />
        )
      )}
      {isOwner && report && parts && (
        <DocEditorModal
          kind="report"
          open={editing}
          initial={reportEditorText(parts.title, parts.body)}
          images={pictures}
          onClose={() => setEditing(false)}
          onSave={onSaveEdit}
        />
      )}
      {run && (
        <ConsentDialog
          open={run.needsConsent}
          provider={providerNameFor(modelLabel(run.model))}
          onCancel={() => dismissConsent(expId, 'report')}
          onAgree={async () => {
            if (user) await recordAiConsent(user.id);
            void resendAfterConsent(expId, 'report');
          }}
        />
      )}
      <Lightbox image={lightbox?.image ?? null} images={lightbox?.images ?? []} onClose={() => setLightbox(null)} />
    </Wrap>
  );
};

export default RecordingReport;
