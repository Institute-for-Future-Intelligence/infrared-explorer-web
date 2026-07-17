import { useEffect, useState } from 'react';
import { Input, Modal, Radio } from 'antd';
import type { ShowcaseCard } from '../../utils/homeLayout';

const REASONS = ['Inappropriate content', 'Privacy concern', 'Spam or low quality', 'Other'] as const;

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, '');

/**
 * Staff takedown confirmation: pick a reason (audited on the doc) and confirm. Deliberately explicit
 * — this removes the experiment from the whole site at once, and the owner can't restore it.
 */
const TakedownModal = ({
  target,
  onCancel,
  onConfirm,
}: {
  target: ShowcaseCard | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) => {
  const [reason, setReason] = useState<(typeof REASONS)[number]>('Inappropriate content');
  const [detail, setDetail] = useState('');

  // Reset the form each time a new target opens the modal.
  useEffect(() => {
    if (target) {
      setReason('Inappropriate content');
      setDetail('');
    }
  }, [target]);

  const finalReason = reason === 'Other' && detail.trim() ? detail.trim() : reason;

  return (
    <Modal
      open={!!target}
      title="Take down this experiment?"
      okText="Take down"
      okButtonProps={{ danger: true }}
      onOk={() => onConfirm(finalReason)}
      onCancel={onCancel}
      destroyOnClose
    >
      <p style={{ marginTop: 0 }}>
        <b>{target ? stripHtml(target.displayName ?? 'This experiment') : ''}</b> will be removed from the whole site
        immediately. The owner can't restore it (they can still delete it). This can't be undone by Cancel — only a
        staff Restore brings it back.
      </p>
      <Radio.Group
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}
      >
        {REASONS.map((r) => (
          <Radio key={r} value={r}>
            {r}
          </Radio>
        ))}
      </Radio.Group>
      {reason === 'Other' && (
        <Input.TextArea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Reason (optional)"
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
      )}
    </Modal>
  );
};

export default TakedownModal;
