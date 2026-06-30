import { useState } from 'react';
import { Button, Empty, message } from 'antd';
import styled from 'styled-components';
import { Experiment, ExperimentType } from '../../../types';
import useCommonStore from '../../../stores/common';
import { generateLabReport } from '../../../services/ai';
import { markdownToHtml } from '../../../utils/markdown';

// Renders the AI report (Markdown -> safe HTML). Scrolls within the panel; tightens the default
// heading/list spacing so the report reads cleanly inside the analyzer's side column.
const ReportBody = styled.div`
  font-size: 14px;
  color: black;
  overflow-y: auto;
  max-height: 46vh;
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
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const md = await generateLabReport(experiment.id);
      setReport(md);
      // Patch the cached experiment so leaving and returning keeps the report without a refetch.
      const exp = useCommonStore.getState().experimentMap.get(experiment.id);
      if (exp) useCommonStore.getState().setExperiment(experiment.id, { ...exp, aiReport: md });
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
    <div>
      {isOwner && (
        <Button
          type={report ? 'default' : 'primary'}
          size="small"
          loading={loading}
          disabled={!isRecording}
          onClick={generate}
          style={{ marginBottom: 10 }}
        >
          {report ? '✨ Regenerate' : '✨ Generate AI report'}
        </Button>
      )}
      {isOwner && !isRecording && (
        <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
          Only recording-based experiments are supported.
        </div>
      )}
      {loading && (
        <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
          Analyzing the thermal data… this takes ~20–60s.
        </div>
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
