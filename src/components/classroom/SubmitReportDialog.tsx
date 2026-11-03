/*
 * "Submit to Class…" on an experiment's page: hand its report in to one of the classes the account
 * is enrolled in, under a name the student types (required; the last name typed is remembered per
 * account). A class the report already went to says when, and submitting again replaces that copy.
 * With no class to pick, the dialog says where to join one (Settings › Classes).
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input, Modal, Radio, Spin, Typography, message } from 'antd';
import useCommonStore from '../../stores/common';
import { ClassInfo } from '../../classroom/types';
import { fetchEnrolledClasses, fetchMySubmissions, submitReport } from '../../classroom/classroomApi';
import { userDisplayName } from '../../utils/displayName';

const NAME_KEY = 'ie.classroom.studentName.';

const SubmitReportDialog = ({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) => {
  const user = useCommonStore((s) => s.user);
  const [classes, setClasses] = useState<ClassInfo[] | null>(null);
  const [submitted, setSubmitted] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    setClasses(null);
    setSubmitted({});
    setPicked(null);
    setBusy(false);
    setError(null);
    let saved = '';
    try {
      saved = localStorage.getItem(NAME_KEY + user.id) ?? '';
    } catch {
      // storage blocked: the account's own name stands in
    }
    setName(saved.trim() || userDisplayName(user));
    fetchEnrolledClasses()
      .then((list) => {
        if (cancelled) return;
        setClasses(list);
        if (list.length === 1) setPicked(list[0].id);
      })
      .catch((e) => {
        if (cancelled) return;
        setClasses([]);
        setError((e as Error)?.message || 'Could not load your classes.');
      });
    fetchMySubmissions(projectId)
      .then((s) => {
        if (!cancelled) setSubmitted(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, user, projectId]);

  const chosen = classes?.find((c) => c.id === picked) ?? null;
  const none = classes != null && classes.length === 0;

  const submit = async () => {
    if (!chosen || !user || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await submitReport(chosen.id, projectId, name);
      try {
        localStorage.setItem(NAME_KEY + user.id, name.trim());
      } catch {
        // storage blocked: nothing to remember
      }
      message.success(res.replaced ? `Report updated in ${chosen.name}.` : `Report submitted to ${chosen.name}.`);
      onClose();
    } catch (e) {
      setError((e as Error)?.message || 'Could not submit the report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Submit to Class"
      okText={none ? 'OK' : 'Submit'}
      onOk={none ? onClose : submit}
      okButtonProps={none ? undefined : { loading: busy, disabled: !chosen || !name.trim() }}
      cancelButtonProps={none ? { style: { display: 'none' } } : { disabled: busy }}
      onCancel={onClose}
      width={460}
      destroyOnHidden
    >
      {classes == null ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : none ? (
        <Typography.Paragraph style={{ marginTop: 12 }}>
          You are not in a class yet. Join one in <Link to="/settings">Settings › Classes</Link>, then submit the report
          here.
        </Typography.Paragraph>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
          <div>
            <div style={{ color: 'var(--ifi-grey)', fontSize: 13, marginBottom: 6 }}>
              {classes.length === 1 ? 'Class' : 'Which class?'}
            </div>
            <Radio.Group
              value={picked}
              onChange={(e) => setPicked(e.target.value as string)}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {classes.map((c) => (
                <Radio key={c.id} value={c.id} disabled={busy}>
                  <span>{c.name || 'Unnamed class'}</span>
                  <div style={{ fontSize: 12, color: 'var(--ifi-grey)' }}>
                    {submitted[c.id] != null
                      ? `Submitted ${new Date(submitted[c.id]).toLocaleString()} — submitting again replaces it`
                      : c.teacherName.trim() || 'Teacher'}
                  </div>
                </Radio>
              ))}
            </Radio.Group>
          </div>
          <div>
            <div style={{ color: 'var(--ifi-grey)', fontSize: 13, marginBottom: 6 }}>Your name</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Required"
              disabled={busy}
              onPressEnter={submit}
            />
            <div style={{ fontSize: 12, color: 'var(--ifi-grey)', marginTop: 4 }}>
              The teacher sees the report under this name.
            </div>
          </div>
        </div>
      )}
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
    </Modal>
  );
};

export default SubmitReportDialog;
