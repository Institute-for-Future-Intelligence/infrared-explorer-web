import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, Select, Spin, Tag, Modal, message } from 'antd';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import EmptyState from '../../components/emptyState';
import ModerationNotePrompt from '../../components/moderationNotePrompt';
import {
  REPORT_REASONS,
  StreetViewReportRow,
  listAutoHiddenSince,
  listOpenStreetViewReports,
  listResolvedStreetViewReports,
  lookupUserNames,
  resolveReport,
  reviewStreetView,
  suspendAuthor,
} from '../../services/streetViewModeration';

/*
 * Admin → Street view reports.
 *
 * The map has no pre-publication review, so by the time a report reaches this page the
 * automation has usually already answered it: a weighted report hides the panorama within
 * seconds. What is left for a person is the part automation cannot do — deciding whether the
 * thing was actually wrong, putting back what was not, and stopping an author who keeps at it.
 *
 * Two things here exist because of specific failure modes rather than tidiness:
 *   · Bulk restore. Several gates make a report-bombing run expensive (a daily cap per reporter,
 *     an hourly circuit breaker) but none makes it impossible, and the recovery has to be one
 *     action rather than a hunt through the map.
 *   · Dismiss. reviewStreetView acts on a panorama; a report about an *author*, or about a
 *     panorama its owner has since deleted, has no panorama to act on. Without this they stay
 *     open for ever and Monday's digest keeps asking.
 */

const RESTORE_WINDOWS = [
  { label: 'the last hour', value: 60 * 60 * 1000 },
  { label: 'the last 6 hours', value: 6 * 60 * 60 * 1000 },
  { label: 'the last 24 hours', value: 24 * 60 * 60 * 1000 },
  { label: 'the last 7 days', value: 7 * 24 * 60 * 60 * 1000 },
];

const TAKEDOWN_REASONS = ['Inappropriate content', 'Privacy concern', 'Spam or not a street view', 'Other'];
const SUSPEND_REASONS = [
  'Repeated violations of the Terms of Service',
  'Publishing other people without their consent',
  'Spam',
  'Other',
];

const reasonLabel = (value: string) => REPORT_REASONS.find((r) => r.value === value)?.label ?? value;
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '—');

interface ReportGroup {
  key: string;
  kind: 'streetview' | 'author';
  svId?: string;
  /** The account the report is about: the panorama's owner, or the reported author. */
  subjectId: string;
  title: string;
  reports: StreetViewReportRow[];
  newestMillis: number;
  autoHidden: boolean;
}

function groupReports(rows: StreetViewReportRow[]): ReportGroup[] {
  const groups = new Map<string, ReportGroup>();
  for (const r of rows) {
    const key = r.targetType === 'author' ? `author:${r.authorId}` : `sv:${r.svId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind: r.targetType,
        svId: r.svId,
        subjectId: (r.targetType === 'author' ? r.authorId : r.svOwnerId) ?? '',
        title: r.targetType === 'author' ? 'This author' : r.svTitle || r.svId || 'Untitled',
        reports: [],
        newestMillis: 0,
        autoHidden: false,
      };
      groups.set(key, g);
    }
    g.reports.push(r);
    g.newestMillis = Math.max(g.newestMillis, r.createdAtMillis ?? 0);
    g.autoHidden = g.autoHidden || r.autoHidden;
  }
  return [...groups.values()].sort((a, b) => b.newestMillis - a.newestMillis);
}

const StreetViewReports = () => {
  const user = useCommonStore((state) => state.user);
  const staff = isStaff(user);
  const [open, setOpen] = useState<StreetViewReportRow[]>([]);
  const [resolved, setResolved] = useState<StreetViewReportRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState<number>(RESTORE_WINDOWS[1].value);
  const [removeFor, setRemoveFor] = useState<ReportGroup | null>(null);
  const [suspendFor, setSuspendFor] = useState<ReportGroup | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [openRows, resolvedRows] = await Promise.all([
        listOpenStreetViewReports(),
        listResolvedStreetViewReports(),
      ]);
      setOpen(openRows);
      setResolved(resolvedRows);
      const ids = [...openRows, ...resolvedRows].flatMap((r) => [r.svOwnerId ?? '', r.authorId ?? '']);
      setNames(await lookupUserNames(ids));
    } catch (e) {
      console.error('failed to load street view reports', e);
      message.error('Could not load the report queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!staff) {
      setLoading(false);
      return;
    }
    void load();
  }, [staff, load]);

  const groups = useMemo(() => groupReports(open), [open]);
  const nameOf = useCallback((id: string) => (id ? names.get(id) || id : 'unknown'), [names]);

  /** Close every open report in a group without touching content. */
  const dismissGroup = useCallback(async (group: ReportGroup, outcome: 'kept' | 'suspended') => {
    for (const r of group.reports) {
      await resolveReport(r.id, outcome);
    }
  }, []);

  const run = useCallback(
    async (key: string, work: () => Promise<string>) => {
      setBusyKey(key);
      try {
        message.success(await work());
        await load();
      } catch (e) {
        console.error('moderation action failed', e);
        message.error((e as { message?: string }).message || 'That did not work.');
      } finally {
        setBusyKey(null);
      }
    },
    [load],
  );

  const onRestore = (group: ReportGroup) =>
    run(group.key, async () => {
      const res = await reviewStreetView(group.svId!, 'restore');
      return `Back on the map. ${res.reportsClosed} report${res.reportsClosed === 1 ? '' : 's'} closed; it will not be auto-hidden again.`;
    });

  const onRemove = (note: string) => {
    const group = removeFor;
    if (!group) return;
    setRemoveFor(null);
    void run(group.key, async () => {
      const res = await reviewStreetView(group.svId!, 'remove', note);
      return res.legacy
        ? 'Removed. This one is from the seeded map, so its source files on intofuture.org still need removing by hand.'
        : `Removed. ${res.reportsClosed} report${res.reportsClosed === 1 ? '' : 's'} closed and the author has been told.`;
    });
  };

  const onSuspend = (note: string) => {
    const group = suspendFor;
    if (!group) return;
    setSuspendFor(null);
    void run(group.key, async () => {
      await suspendAuthor(group.subjectId, true, note);
      await dismissGroup(group, 'suspended');
      return 'This account can no longer publish anything. Undo it from here by suspending again with "Allow uploads".';
    });
  };

  const onDismiss = (group: ReportGroup) =>
    run(group.key, async () => {
      await dismissGroup(group, 'kept');
      return `Closed ${group.reports.length} report${group.reports.length === 1 ? '' : 's'}.`;
    });

  const onUnsuspend = (group: ReportGroup) =>
    run(group.key, async () => {
      await suspendAuthor(group.subjectId, false);
      return 'This account can publish again.';
    });

  // Bulk restore: the answer to a bombing run, and the reason the auto-hide is allowed to be
  // this quick in the first place — an action taken in seconds has to be undoable in seconds.
  const onBulkRestore = useCallback(async () => {
    const cutoff = Date.now() - windowMs;
    let rows;
    try {
      rows = await listAutoHiddenSince(cutoff);
    } catch (e) {
      console.error('failed to list auto-hidden street views', e);
      message.error('Could not read what was hidden.');
      return;
    }
    if (rows.length === 0) {
      message.info('Nothing was auto-hidden in that window.');
      return;
    }
    Modal.confirm({
      title: `Put ${rows.length} street view${rows.length === 1 ? '' : 's'} back on the map?`,
      width: 520,
      content: (
        <>
          <p>
            Everything the automation hid in {RESTORE_WINDOWS.find((w) => w.value === windowMs)?.label} goes back up,
            its reports are closed as unfounded, and each one becomes immune to being auto-hidden again. Use this after
            a burst of bad-faith reports, not as a way to clear the queue.
          </p>
          <ul style={{ maxHeight: 180, overflow: 'auto', paddingLeft: 18 }}>
            {rows.slice(0, 40).map((r) => (
              <li key={r.svId}>
                {r.title} <span style={{ color: '#999' }}>· {when(r.hiddenAtMillis)}</span>
              </li>
            ))}
            {rows.length > 40 && <li>…and {rows.length - 40} more</li>}
          </ul>
        </>
      ),
      okText: `Restore ${rows.length}`,
      onOk: async () => {
        let done = 0;
        let failed = 0;
        for (const r of rows) {
          try {
            await reviewStreetView(r.svId, 'restore');
            done += 1;
          } catch (e) {
            console.error('restore failed', r.svId, e);
            failed += 1;
          }
        }
        if (failed) message.warning(`Restored ${done}; ${failed} could not be restored.`);
        else message.success(`Restored ${done}.`);
        await load();
      },
    });
  }, [windowMs, load]);

  if (!staff) {
    return <EmptyState title="Staff only" hint="This page is for the Infrared Explorer moderation team." />;
  }

  return (
    <div className="admin-page" style={{ padding: '16px 20px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Street view reports</h2>
        <Select
          size="small"
          value={windowMs}
          onChange={setWindowMs}
          options={RESTORE_WINDOWS.map((w) => ({ label: w.label, value: w.value }))}
          style={{ width: 150 }}
        />
        <Button size="small" onClick={onBulkRestore}>
          Restore everything auto-hidden in…
        </Button>
        <Button size="small" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>
      <p style={{ color: '#888', marginTop: 0 }}>
        A report from an established account hides a panorama by itself, within seconds. What is left here is deciding
        whether it should stay hidden. Confirmed violations are removed and the author suspended within 24 hours.
      </p>

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin size="large" />
        </div>
      ) : groups.length === 0 ? (
        <Empty description="Nothing waiting" style={{ padding: 32 }} />
      ) : (
        groups.map((group) => (
          <div
            key={group.key}
            style={{
              border: '1px solid #eee',
              borderRadius: 8,
              padding: '12px 14px',
              marginBottom: 12,
              background: '#fff',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 15 }}>
                {group.kind === 'author' ? `Author: ${nameOf(group.subjectId)}` : group.title}
              </b>
              {group.kind === 'streetview' && (
                <span style={{ color: '#888', fontSize: 12 }}>by {nameOf(group.subjectId)}</span>
              )}
              {group.autoHidden && <Tag color="orange">hidden automatically</Tag>}
              <Tag>
                {group.reports.length} report{group.reports.length === 1 ? '' : 's'}
              </Tag>
              <span style={{ flex: 1 }} />
              <span style={{ color: '#999', fontSize: 12 }}>{when(group.newestMillis)}</span>
            </div>

            <ul style={{ margin: '8px 0 10px', paddingLeft: 18 }}>
              {group.reports.map((r) => (
                <li key={r.id} style={{ marginBottom: 4 }}>
                  <span>{reasonLabel(r.reason)}</span>
                  {r.details && <span style={{ color: '#555' }}> — “{r.details}”</span>}
                  <span style={{ color: '#999', fontSize: 12 }}>
                    {' '}
                    · {r.reporterId ? nameOf(r.reporterId) : 'not signed in'}
                    {r.reporterWeight === 1 ? '' : ' · advisory only'}
                    {r.priorReports > 0 ? ` · reported before (${r.priorReports}×)` : ''}
                  </span>
                </li>
              ))}
            </ul>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {group.kind === 'streetview' ? (
                <>
                  <Link to={`/streetview?sv=${encodeURIComponent(group.svId ?? '')}`} target="_blank">
                    <Button size="small">Look at it</Button>
                  </Link>
                  <Button size="small" onClick={() => onRestore(group)} loading={busyKey === group.key}>
                    Put it back
                  </Button>
                  <Button size="small" danger onClick={() => setRemoveFor(group)}>
                    Remove…
                  </Button>
                </>
              ) : (
                <Link to={`/users/${encodeURIComponent(group.subjectId)}`} target="_blank">
                  <Button size="small">See what they published</Button>
                </Link>
              )}
              {group.subjectId && group.subjectId !== 'system' && (
                <>
                  <Button size="small" danger onClick={() => setSuspendFor(group)}>
                    Suspend author…
                  </Button>
                  <Button size="small" onClick={() => onUnsuspend(group)} loading={busyKey === group.key}>
                    Allow uploads
                  </Button>
                </>
              )}
              <Button size="small" type="text" onClick={() => onDismiss(group)} loading={busyKey === group.key}>
                Nothing wrong — close
              </Button>
            </div>
          </div>
        ))
      )}

      {/* The verdicts already given, so a wrong one can be found and undone. */}
      {resolved.length > 0 && (
        <details className="takedown-review" style={{ marginTop: 24 }}>
          <summary>Already dealt with ({resolved.length})</summary>
          <div style={{ marginTop: 8 }}>
            {resolved.map((r) => (
              <div
                key={r.id}
                style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', flexWrap: 'wrap' }}
              >
                <span style={{ flex: 1, minWidth: 200 }}>
                  {r.targetType === 'author' ? `Author: ${nameOf(r.authorId ?? '')}` : r.svTitle || r.svId}
                  <span style={{ color: '#999', fontSize: 12 }}> · {reasonLabel(r.reason)}</span>
                </span>
                <Tag color={r.outcome === 'kept' ? 'green' : 'red'}>{r.outcome ?? r.status}</Tag>
                <span style={{ color: '#999', fontSize: 12 }}>{when(r.resolvedAtMillis)}</span>
                {r.targetType === 'streetview' && r.outcome !== 'kept' && r.svId && (
                  <Button
                    size="small"
                    onClick={() =>
                      run(r.id, async () => {
                        await reviewStreetView(r.svId!, 'restore');
                        return 'Back on the map.';
                      })
                    }
                    loading={busyKey === r.id}
                  >
                    Put it back
                  </Button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      <ModerationNotePrompt
        open={!!removeFor}
        title="Remove this street view?"
        okText="Remove"
        reasons={TAKEDOWN_REASONS}
        description={
          <p style={{ marginTop: 0 }}>
            <b>{removeFor?.title}</b> comes off the map for everyone and its pictures are deleted. The author is told
            what happened, with this reason, and can appeal.
          </p>
        }
        onCancel={() => setRemoveFor(null)}
        onConfirm={onRemove}
      />

      <ModerationNotePrompt
        open={!!suspendFor}
        title="Suspend this author?"
        okText="Suspend"
        reasons={SUSPEND_REASONS}
        description={
          <p style={{ marginTop: 0 }}>
            <b>{suspendFor ? nameOf(suspendFor.subjectId) : ''}</b> will not be able to publish street views or
            experiments until the suspension is lifted. What they have already published stays up unless it is removed
            separately.
          </p>
        }
        onCancel={() => setSuspendFor(null)}
        onConfirm={onSuspend}
      />
    </div>
  );
};

export default StreetViewReports;
