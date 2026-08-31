import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Select, message } from 'antd';
import styled from 'styled-components';
import { Experiment, DEFAULT_MODEL, MODEL_KEYS, MODEL_LABELS, QaModel, isModelKey } from '../../../types';
import useCommonStore from '../../../stores/common';
import { generateLabReport } from '../../../services/ai';
import { markdownToHtml } from '../../../utils/markdown';

// Renders the AI report (Markdown -> safe HTML). Fills the tab's full height and scrolls internally;
// tightens the default heading/list spacing so the report reads cleanly inside the analyzer's side
// column. flex:1/min-height:0 lets it consume the height the parent column gives it (see wrapper).
const ReportBody = styled.div`
  font-size: 14px;
  color: black;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  /* The side column is narrow; a long unbroken token (a KaTeX span, a URL, a wide number) must wrap
     rather than push the whole report into a horizontal scroll. Tables opt out via .md-table below. */
  overflow-wrap: break-word;
  /* Three distinct heading levels, all at or above the 14px body size — h5 used to render at 13px, so a
     report's subheadings came out SMALLER and weaker than the text they introduced. */
  h4 {
    font-size: 17px;
    margin: 14px 0 4px;
  }
  h5 {
    font-size: 15px;
    margin: 12px 0 4px;
  }
  h6 {
    font-size: 14px;
    margin: 10px 0 4px;
    color: #333;
  }
  p {
    margin: 4px 0;
  }
  ul,
  ol {
    margin: 4px 0;
    padding-left: 20px;
  }
  li {
    margin: 2px 0;
  }
  /* GFM tables: scroll horizontally instead of squishing in the narrow side column. */
  .md-table {
    overflow-x: auto;
    margin: 8px 0;
  }
  table {
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    border: 1px solid #e0e0e0;
    padding: 3px 7px;
    text-align: left;
    white-space: nowrap;
  }
  th {
    background: #fafafa;
    font-weight: 600;
  }
`;

interface Props {
  experiment: Experiment;
}

/** Outcome of one generation. Resolved, never rejected, so an in-flight request nobody is attached to
 *  can't surface as an unhandled rejection. */
type GenOutcome = { ok: true; report: string; model: QaModel } | { ok: false };

/**
 * Generations currently running, keyed by experiment id — MODULE level on purpose.
 *
 * workspacePanel renders the tabs conditionally, so switching to Charts mid-generation UNMOUNTS this
 * panel and used to take the `loading` guard with it: coming back showed an idle "Generate" button, and
 * a second click started a second (billed, rate-limited) run whose result raced the first to overwrite
 * the same Firestore field. Keeping the promise here means a remount re-attaches to the run in progress,
 * and a duplicate can never start.
 */
const inFlight = new Map<string, { promise: Promise<GenOutcome>; model: QaModel }>();

/** Human-readable text for a failed generateLabReport call. */
const failureText = (err: unknown): string => {
  const code = (err as { code?: string })?.code;
  if (code === 'functions/failed-precondition') {
    return (err as { message?: string }).message || 'This experiment has no thermal data to analyze.';
  }
  if (code === 'functions/resource-exhausted') return 'Usage limit reached. Please try again later.';
  return (err as { message?: string })?.message || 'Report generation failed. Please try again.';
};

/**
 * Start (or join) the generation for `expId`. The store patch happens HERE rather than in the component
 * so a report finishing while the panel is unmounted is still kept — otherwise it was thrown away and
 * only reappeared after a refetch.
 */
const startGeneration = (expId: string, model: QaModel): Promise<GenOutcome> => {
  const existing = inFlight.get(expId);
  if (existing) return existing.promise;
  const promise: Promise<GenOutcome> = (async () => {
    try {
      const md = await generateLabReport(expId, model);
      const exp = useCommonStore.getState().experimentMap.get(expId);
      if (exp) useCommonStore.getState().setExperiment(expId, { ...exp, aiReport: md, aiReportModel: model });
      return { ok: true as const, report: md, model };
    } catch (err) {
      message.error(failureText(err));
      return { ok: false as const };
    } finally {
      inFlight.delete(expId);
    }
  })();
  inFlight.set(expId, { promise, model });
  return promise;
};

/**
 * AI lab-report tab. Owners generate a physics-grounded report from the experiment's real thermal
 * data (via the generateLabReport callable, which also persists it on the experiment doc); everyone
 * who can view the experiment sees the saved report. Both media types work: a video showcase's single
 * .vir decodes server-side into the same numeric summary a recording's per-frame files do.
 */
const AiReport = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && user.id === experiment.ownerId;

  const [report, setReport] = useState<string>(experiment.aiReport ?? '');
  // Which model produced the currently shown report (for the badge). Starts from the saved value, but a
  // report generated before the model set changed carries a now-removed key (e.g. an old Claude 'opus');
  // drop it so the badge hides instead of rendering a blank label (MODEL_LABELS has no entry for it).
  const [reportModel, setReportModel] = useState<QaModel | undefined>(
    isModelKey(experiment.aiReportModel) ? experiment.aiReportModel : undefined,
  );
  // Seeded from the module map so a remount mid-generation shows the progress notice immediately.
  const [loading, setLoading] = useState(() => inFlight.has(experiment.id));
  // The model the RUNNING generation was started with — not necessarily the picker's current value,
  // which the user may have changed (or which may be another session's default after a remount).
  const [runningModel, setRunningModel] = useState<QaModel | undefined>(() => inFlight.get(experiment.id)?.model);
  // Last failure, kept on screen until the next attempt: the 3s toast was easy to miss, leaving the
  // previous report and its "Generated by …" badge looking like the result of the run that just failed.
  const [failure, setFailure] = useState('');
  // Bumped when this panel starts a run, so the attach effect below picks up the new promise.
  const [attempt, setAttempt] = useState(0);

  // Selected model for the NEXT generation, persisted across sessions. The picker mirrors the Q&A panel;
  // an old saved value under a now-removed key falls back to the default.
  const [model, setModel] = useState<QaModel>(() => {
    const saved = localStorage.getItem('report-model');
    return isModelKey(saved) ? saved : DEFAULT_MODEL;
  });
  const setModelPersist = (m: QaModel) => {
    setModel(m);
    localStorage.setItem('report-model', m);
  };

  // Attach to whichever generation is running for this experiment — the one this panel just started, or
  // one still in flight from before a tab switch unmounted us. `alive` drops the result on unmount; the
  // run itself keeps going and still patches the store.
  useEffect(() => {
    const pending = inFlight.get(experiment.id);
    if (!pending) return;
    let alive = true;
    setLoading(true);
    setRunningModel(pending.model);
    pending.promise.then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res.ok) {
        setReport(res.report);
        setReportModel(res.model);
        setFailure('');
      } else {
        setFailure('Generation failed. The report below, if any, is the previously saved one.');
      }
    });
    return () => {
      alive = false;
    };
  }, [experiment.id, attempt]);

  const generate = () => {
    if (inFlight.has(experiment.id)) return;
    setFailure('');
    startGeneration(experiment.id, model);
    setAttempt((n) => n + 1);
  };

  // KaTeX rendering is not cheap and this component re-renders on every played frame; without this the
  // whole report was re-parsed ~20x/second during 4x playback.
  const reportHtml = useMemo(() => (report ? markdownToHtml(report) : ''), [report]);

  return (
    // Full-height flex column so the report body stretches to the bottom of the workspace panel instead
    // of being capped to a short box (the workspace gives it a definite height).
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Button type={report ? 'default' : 'primary'} size="small" loading={loading} onClick={generate}>
            {report ? '✨ Regenerate' : '✨ Generate AI report'}
          </Button>
          {/* Labelled explicitly: this picks the model for the NEXT run, while the line below reads
              "Generated by …" for the saved one — two model names side by side were indistinguishable. */}
          <Select
            size="small"
            value={model}
            onChange={setModelPersist}
            disabled={loading}
            style={{ width: 172 }}
            aria-label="Model to use for the next report"
            title="Model to use for the next report"
            options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
          />
        </div>
      )}
      {/* One live region for the whole status line, so a screen reader is told when a 20-60s generation
          starts and when it finishes instead of sitting silent throughout. */}
      <div role="status" aria-live="polite">
        {loading && (
          <div style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
            Analyzing the thermal data with {MODEL_LABELS[runningModel ?? model]}… this takes ~20–60s.
          </div>
        )}
        {failure && !loading && <div style={{ fontSize: 12, color: '#cf1322', marginBottom: 8 }}>{failure}</div>}
        {report && reportModel && !loading && !failure && (
          <div style={{ fontSize: 12, color: '#595959', marginBottom: 8 }}>
            Generated by {MODEL_LABELS[reportModel]}
          </div>
        )}
      </div>
      {report ? (
        <ReportBody dangerouslySetInnerHTML={{ __html: reportHtml }} />
      ) : (
        !loading && (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={isOwner ? 'No report yet — click the button above to generate one.' : 'No AI report yet.'}
          />
        )
      )}
    </div>
  );
};

export default AiReport;
