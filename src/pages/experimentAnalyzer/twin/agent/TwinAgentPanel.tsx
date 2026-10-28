/**
 * The agent build in the twin panel (docs/digital-twin-plan.md §43.5, beta): a button that starts it,
 * the conversation as it runs — the model's words, its tool steps and the pictures its tools return,
 * drawn by the Ask AI thread's own Conversation — a Stop, and the error if one came. The twin itself
 * appears in the viewer above the moment finish has written it.
 */
import { Alert, Button, Select } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import type { Experiment, QaModel } from '../../../../types';
import Conversation from '../../ai/RecordingReplies';
import { setTwinAgentModel, startTwinAgent, stopTwinAgent, useTwinAgentView } from './twinAgentRunner';

const MODELS: { value: QaModel; label: string }[] = [
  { value: 'gpt6luna', label: 'GPT-6 Luna' },
  { value: 'gemini', label: 'Gemini 2.5 Pro' },
  { value: 'grok47', label: 'Grok 4.7' },
  { value: 'deepseek', label: 'DeepSeek Flash' },
];

const TwinAgentPanel = ({ experiment, disabled }: { experiment: Experiment; disabled?: boolean }) => {
  const v = useTwinAgentView(experiment.id);
  return (
    <section className="twin-section twin-agent">
      <div className="twin-section-title">
        <span>Agent build (beta)</span>
        {v.running && (
          <Button size="small" danger onClick={() => stopTwinAgent(experiment.id)}>
            Stop
          </Button>
        )}
      </div>
      <div className="twin-note-muted">
        The AI measures the recording first — where each thing is, in thermal pixels — then writes the scene from those
        numbers and checks it against the frame before saving it. For a camera that stood still above the bench.
      </div>
      <div className="twin-agent-start">
        <Select
          size="small"
          value={v.model}
          onChange={(m) => setTwinAgentModel(experiment.id, m)}
          options={MODELS}
          disabled={v.running}
          style={{ minWidth: 150 }}
        />
        <Button
          size="small"
          type="primary"
          icon={<RobotOutlined />}
          loading={v.running}
          disabled={disabled || v.running}
          onClick={() => void startTwinAgent(experiment)}
        >
          {v.started ? 'Build again' : 'Build with the agent'}
        </Button>
      </div>
      {v.error && <Alert type="error" showIcon closable message={v.error} />}
      {v.finished && !v.running && <Alert type="success" showIcon message="The twin is saved; the viewer shows it." />}
      {v.started && (
        <div className="twin-agent-thread">
          <Conversation
            turns={v.turns}
            images={v.images}
            model={v.model}
            live={{ running: v.running, liveText: v.liveText, status: v.status, preview: null }}
            showFailures
            onOpenImage={(i) => window.open(i.url, '_blank', 'noopener')}
          />
        </div>
      )}
    </section>
  );
};

export default TwinAgentPanel;
