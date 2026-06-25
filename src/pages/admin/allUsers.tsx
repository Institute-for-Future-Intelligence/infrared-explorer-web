import { useEffect, useMemo, useState } from 'react';
import { Input, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import styled from 'styled-components';
import dayjs from 'dayjs';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import { AdminUserRow, AdminUsersResult, listAllUsers } from '../../services/admin';

// Admin → "List All Users" (telelab parity: client/src/pages/home/users.tsx). The live-mode
// "Rooms Visited / Rooms Created" columns are dropped — this app has no rooms — leaving the
// identity + activity columns. The header tallies registrations by role like telelab did.

// Keep the copy affordances quiet: neutral gray (not antd's primary blue) and revealed only
// when the row is hovered, so the table reads cleanly at rest.
const TableWrapper = styled.div`
  .ant-typography-copy {
    color: rgba(0, 0, 0, 0.35);
    opacity: 0;
    transition: opacity 0.2s;
  }
  .ant-typography-copy:hover {
    color: rgba(0, 0, 0, 0.65);
  }
  .ant-table-row:hover .ant-typography-copy {
    opacity: 1;
  }
`;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// "1 student" / "3 students" — naive +s plural is fine for these role nouns ('other' -> 'others').
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

const ROLE_COLORS: Record<string, string> = {
  student: 'blue',
  teacher: 'green',
  admin: 'red',
  host: 'purple',
  researcher: 'gold',
  other: 'default',
};

const columns: ColumnsType<AdminUserRow> = [
  {
    title: 'Name',
    dataIndex: 'displayName',
    key: 'displayName',
    sorter: (a, b) => a.displayName.localeCompare(b.displayName),
    ellipsis: true,
  },
  {
    title: 'Email',
    dataIndex: 'email',
    key: 'email',
    render: (email: string) =>
      email ? (
        <Typography.Text copyable={{ text: email }} ellipsis>
          {email}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">—</Typography.Text>
      ),
  },
  {
    title: 'Role',
    dataIndex: 'role',
    key: 'role',
    render: (r: string) => <Tag color={ROLE_COLORS[r] ?? 'default'}>{cap(r)}</Tag>,
    sorter: (a, b) => a.role.localeCompare(b.role),
  },
  {
    title: 'Join Date',
    dataIndex: 'createdAtMillis',
    key: 'createdAtMillis',
    render: (ms: number | null) => (ms ? dayjs(ms).format('MM/DD/YYYY hh:mm a') : ''),
    sorter: (a, b) => (a.createdAtMillis ?? 0) - (b.createdAtMillis ?? 0),
    defaultSortOrder: 'descend',
  },
  {
    title: 'System ID',
    dataIndex: 'id',
    key: 'id',
    render: (id: string) => (
      <Typography.Text type="secondary" copyable={{ text: id }} style={{ fontFamily: 'monospace', fontSize: 12 }}>
        {id}
      </Typography.Text>
    ),
  },
  {
    title: 'Clips',
    dataIndex: 'clips',
    key: 'clips',
    align: 'right',
    width: 90,
    sorter: (a, b) => a.clips - b.clips,
  },
  {
    title: 'Comments',
    dataIndex: 'comments',
    key: 'comments',
    align: 'right',
    width: 110,
    sorter: (a, b) => a.comments - b.comments,
  },
];

const AllUsers = () => {
  const user = useCommonStore((state) => state.user);
  const [result, setResult] = useState<AdminUsersResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [term, setTerm] = useState('');

  useEffect(() => {
    if (!isStaff(user)) return;
    setLoading(true);
    listAllUsers()
      .then(setResult)
      .finally(() => setLoading(false));
  }, [user]);

  // "594 users (541 students, 34 teachers) have registered." — generalized over whatever roles
  // are actually present so admins/researchers/etc. also show up.
  const summary = useMemo(() => {
    if (!result) return '';
    const total = result.users.length;
    const order = ['student', 'teacher', 'admin', 'host', 'researcher', 'other'];
    const present = Object.keys(result.roleCounts).sort(
      (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
    );
    const parts = present.map((r) => plural(result.roleCounts[r], r));
    return `${plural(total, 'user')}${parts.length ? ` (${parts.join(', ')})` : ''} have registered.`;
  }, [result]);

  // Free-text filter across name / email / role / system id. Counts in the summary above stay
  // on the full registry; only the table rows are filtered.
  const rows = useMemo(() => {
    const all = result?.users ?? [];
    const q = term.trim().toLowerCase();
    if (!q) return all;
    return all.filter((u) => [u.displayName, u.email, u.role, u.id].some((f) => (f ?? '').toLowerCase().includes(q)));
  }, [result, term]);

  if (!isStaff(user)) return <div style={{ padding: 24 }}>You do not have access to this page.</div>;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '8px 16px 24px' }}>
      <h2 style={{ textAlign: 'center', marginBottom: 4 }}>All Users</h2>
      <p style={{ textAlign: 'center', color: 'rgba(0,0,0,0.55)', marginBottom: 16 }}>{summary}</p>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <Input.Search
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          allowClear
          style={{ width: 420, maxWidth: '90vw' }}
          placeholder="Search by name, email, role, or system ID…"
        />
      </div>
      <TableWrapper>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{
            defaultPageSize: 20,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (t) => `${t} ${t === 1 ? 'user' : 'users'}`,
          }}
        />
      </TableWrapper>
    </div>
  );
};

export default AllUsers;
