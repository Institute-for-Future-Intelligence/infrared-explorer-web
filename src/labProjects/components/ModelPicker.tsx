/*
 * The chat model of a project, picked before the conversation starts (the
 * server fixes it at the first message): a dropdown on an empty Discuss, as
 * the app's ModelPicker. While a pick is on its way to the server the field
 * shows it with a spinner.
 */

import { Select } from 'antd';
import styled from 'styled-components';

const Wrap = styled.div`
  margin-top: 24px;
  text-align: left;

  .mp-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .mp-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--ifi-text-secondary);
  }
  .mp-row .ant-select {
    flex: 1;
    max-width: 320px;
  }
  .mp-hint {
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--ifi-text-tertiary);
  }
`;

const ModelPicker = ({
  choices,
  selected,
  disabled,
  saving,
  onPick,
}: {
  choices: { key: string; label: string }[];
  selected: string | null;
  disabled: boolean;
  /** The pick shown is being saved. */
  saving: boolean;
  onPick: (key: string) => void;
}) => (
  <Wrap>
    <div className="mp-row">
      <span className="mp-title">Model</span>
      <Select
        value={selected ?? undefined}
        placeholder="Choose a model"
        options={choices.map((c) => ({ value: c.key, label: c.label }))}
        disabled={disabled}
        loading={saving}
        onChange={(key) => onPick(key)}
        aria-label="Model"
      />
    </div>
    <div className="mp-hint">The experiment keeps this model once you send the first message.</div>
  </Wrap>
);

export default ModelPicker;
