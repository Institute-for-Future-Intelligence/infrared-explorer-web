import { ReactNode, useEffect, useState } from 'react';
import { Input, Modal, Radio } from 'antd';

/*
 * The one "are you sure, and why?" dialog the street-view moderation tools share — a staff
 * takedown from the viewer, and Remove / Suspend author from the admin queue.
 *
 * The note is not decoration: it is written onto the document as `takedownReason` (or the
 * suspension's reason) and it is what the author is told. A moderation action nobody can account
 * for later is the kind a review board asks about, so the field is always here, pre-filled with a
 * reason list when there is a sensible one.
 */

const MAX_NOTE = 500;

const ModerationNotePrompt = ({
  open,
  title,
  description,
  okText,
  reasons,
  placeholder,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  okText: string;
  /** When given, a radio list; picking "Other" hands the free-text box the final say. */
  reasons?: string[];
  placeholder?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) => {
  const [reason, setReason] = useState<string>(reasons?.[0] ?? '');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setReason(reasons?.[0] ?? '');
      setNote('');
    }
    // `reasons` is a literal at every call site; keying on `open` is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isOther = reason === 'Other';
  const finalNote = (isOther || !reasons ? note.trim() : note.trim() ? `${reason} — ${note.trim()}` : reason).slice(
    0,
    MAX_NOTE,
  );

  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      okButtonProps={{ danger: true, loading: busy, disabled: !finalNote }}
      cancelButtonProps={{ disabled: busy }}
      onOk={() => onConfirm(finalNote)}
      onCancel={busy ? undefined : onCancel}
      closable={!busy}
      maskClosable={!busy}
      destroyOnClose
      width={460}
    >
      <div style={{ marginTop: 0 }}>{description}</div>
      {reasons && (
        <Radio.Group
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}
        >
          {reasons.map((r) => (
            <Radio key={r} value={r}>
              {r}
            </Radio>
          ))}
        </Radio.Group>
      )}
      <Input.TextArea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={MAX_NOTE}
        showCount
        placeholder={placeholder ?? (isOther || !reasons ? 'Reason (required)' : 'Anything to add? (optional)')}
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
    </Modal>
  );
};

export default ModerationNotePrompt;
