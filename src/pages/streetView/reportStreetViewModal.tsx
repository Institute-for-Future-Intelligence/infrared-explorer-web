import { useEffect, useState } from 'react';
import { Alert, Input, Modal, Radio } from 'antd';
import {
  MAX_REPORT_DETAILS,
  REPORT_REASONS,
  ReportReason,
  ReportResult,
  submitStreetViewReport,
} from '../../services/streetViewModeration';

/*
 * Report a panorama, or the person who published it.
 *
 * Open to signed-out visitors on purpose: the report is what moderates this map, and a stranger
 * who recognises their own front door has no account and is not going to make one. What a guest
 * report cannot do is move content on its own — that gate lives server-side, where an anonymous
 * caller cannot argue with it.
 *
 * The dialog stays open when the call fails. A report that vanished with an error toast is a
 * report the person will assume was filed.
 */

export interface ReportTarget {
  kind: 'streetview' | 'author';
  svId?: string;
  authorId?: string;
  /** What the confirmation talks about: the panorama's title, or the author's name. */
  label: string;
}

const ReportStreetViewModal = ({
  target,
  onCancel,
  onDone,
}: {
  target: ReportTarget | null;
  onCancel: () => void;
  onDone: (result: ReportResult, target: ReportTarget) => void;
}) => {
  const [reason, setReason] = useState<ReportReason>('privacy');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setReason('privacy');
      setDetails('');
      setError(null);
      setBusy(false);
    }
  }, [target]);

  // "Something else" says nothing a moderator can act on; the server refuses it too.
  const needsDetails = reason === 'other' && !details.trim();

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitStreetViewReport({
        targetType: target.kind,
        svId: target.svId,
        authorId: target.authorId,
        reason,
        details: details.trim(),
      });
      onDone(result, target);
    } catch (e) {
      console.error('report failed', e);
      setError((e as { message?: string }).message || 'The report could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={target?.kind === 'author' ? 'Report this author' : 'Report this street view'}
      okText="Send report"
      okButtonProps={{ danger: true, disabled: needsDetails, loading: busy }}
      cancelButtonProps={{ disabled: busy }}
      onOk={submit}
      onCancel={busy ? undefined : onCancel}
      closable={!busy}
      maskClosable={!busy}
      destroyOnClose
      width={460}
    >
      {error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      <p style={{ marginTop: 0 }}>
        {target?.kind === 'author'
          ? 'Tell us what is wrong with what this person has published. We look at every report, and you can also hide everything they publish from your own map.'
          : 'Tell us what is wrong with this street view. Reports are read within 24 hours, and a report from a signed-in account takes it off the map straight away.'}
      </p>
      <Radio.Group
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}
      >
        {REPORT_REASONS.map((r) => (
          <Radio key={r.value} value={r.value}>
            {r.label}
          </Radio>
        ))}
      </Radio.Group>
      <Input.TextArea
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        maxLength={MAX_REPORT_DETAILS}
        showCount
        placeholder={reason === 'other' ? 'What is wrong? (required)' : 'Anything else we should know? (optional)'}
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
    </Modal>
  );
};

export default ReportStreetViewModal;
