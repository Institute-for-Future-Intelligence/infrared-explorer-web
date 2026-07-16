import { useState } from 'react';
import { Button, Empty, Select, message } from 'antd';
import styled from 'styled-components';
import {
  Experiment,
  ExperimentType,
  DEFAULT_MODEL,
  MODEL_KEYS,
  MODEL_LABELS,
  QaModel,
  isModelKey,
} from '../../../types';
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
  h4 {
    font-size: 15px;
    margin: 12px 0 4px;
  }
  h5 {
    font-size: 13px;
    margin: 10px 0 4px;
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

/**
 * AI lab-report tab. Owners generate a physics-grounded report from the experiment's real thermal
 * data (via the generateLabReport callable, which also persists it on the experiment doc); everyone
 * who can view the experiment sees the saved report. Recording-sourced experiments only (P0).
 */
const AiReport = ({ experiment }: Props) => {
  const user = useCommonStore((state) => state.user);
  const isOwner = !!user && user.id === experiment.ownerId;
  const isRecording = experiment.sourceType === ExperimentType.Recording;

  const [report, setReport] = useState<string>(experiment.aiReport ?? '');
  // Which model produced the currently shown report (for the badge). Starts from the saved value, but a
  // report generated before the model set changed carries a now-removed key (e.g. an old Claude 'opus');
  // drop it so the badge hides instead of rendering a blank label (MODEL_LABELS has no entry for it).
  const [reportModel, setReportModel] = useState<QaModel | undefined>(
    isModelKey(experiment.aiReportModel) ? experiment.aiReportModel : undefined,
  );
  const [loading, setLoading] = useState(false);

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

  const generate = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const md = await generateLabReport(experiment.id, model);
      setReport(md);
      setReportModel(model);
      // Patch the cached experiment so leaving and returning keeps the report without a refetch.
      const exp = useCommonStore.getState().experimentMap.get(experiment.id);
      if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, aiReport: md, aiReportModel: model });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const msg =
        code === 'functions/failed-precondition'
          ? (err as { message?: string }).message ||
            'This experiment is not supported yet (recording-based experiments only).'
          : code === 'functions/resource-exhausted'
            ? 'Usage limit reached. Please try again later.'
            : (err as { message?: string })?.message || 'Report generation failed. Please try again.';
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    // Full-height flex column so the report body stretches to the bottom of the workspace panel instead
    // of being capped to a short box (the workspace gives it a definite height).
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Button
            type={report ? 'default' : 'primary'}
            size="small"
            loading={loading}
            disabled={!isRecording}
            onClick={generate}
          >
            {report ? '✨ Regenerate' : '✨ Generate AI report'}
          </Button>
          <Select
            size="small"
            value={model}
            onChange={setModelPersist}
            disabled={!isRecording || loading}
            style={{ width: 172 }}
            options={MODEL_KEYS.map((k) => ({ value: k, label: MODEL_LABELS[k] }))}
          />
        </div>
      )}
      {isOwner && !isRecording && (
        <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
          Only recording-based experiments are supported.
        </div>
      )}
      {loading && (
        <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
          Analyzing the thermal data with {MODEL_LABELS[model]}… this takes ~20–60s.
        </div>
      )}
      {report && reportModel && !loading && (
        <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>Generated by {MODEL_LABELS[reportModel]}</div>
      )}
      {report ? (
        <ReportBody dangerouslySetInnerHTML={{ __html: markdownToHtml(report) }} />
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
