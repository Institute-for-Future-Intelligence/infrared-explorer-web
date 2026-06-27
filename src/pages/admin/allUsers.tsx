import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dropdown, Input, Spin, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { FilterOutlined } from '@ant-design/icons';
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
    title: 'Name',
    dataIndex: 'displayName',
    key: 'displayName',
    sorter: (a, b) => a.displayName.localeCompare(b.displayName),
    ellipsis: true,
    render: (name: string) =>
      name ? (
        <Typography.Text copyable={{ text: name }} ellipsis>
          {name}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">—</Typography.Text>
      ),
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
    title: 'Last Activity',
    dataIndex: 'lastActivityMillis',
    key: 'lastActivityMillis',
    // Derived from the user's newest experiment edit or comment (no sign-in timestamp exists);
    // a dash means we have no record of any activity.
    render: (ms: number | null) =>
      ms ? dayjs(ms).format('MM/DD/YYYY hh:mm a') : <Typography.Text type="secondary">—</Typography.Text>,
    sorter: (a, b) => (a.lastActivityMillis ?? 0) - (b.lastActivityMillis ?? 0),
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
  const [roleFilter, setRoleFilter] = useState<string[]>([]);

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

  // Role options for the filter dropdown — canonical order, each labelled with its registry count.
  const roleOptions = useMemo(() => {
    if (!result) return [];
    const order = ['student', 'teacher', 'admin', 'host', 'researcher', 'other'];
    return Object.keys(result.roleCounts)
      .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
      .map((r) => ({ value: r, label: `${cap(r)} (${result.roleCounts[r]})` }));
  }, [result]);

  // Free-text search (name / email / role / system id) AND role filter, combined. Counts in the
  // summary above stay on the full registry; only the table rows are filtered.
  const rows = useMemo(() => {
    const all = result?.users ?? [];
    const q = term.trim().toLowerCase();
    return all.filter((u) => {
      if (roleFilter.length && !roleFilter.includes(u.role)) return false;
      if (q && ![u.displayName, u.email, u.role, u.id].some((f) => (f ?? '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [result, term, roleFilter]);

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
      <p style={{ textAlign: 'center', color: 'rgba(0,0,0,0.55)', margin: '8px 0 16px' }}>{summary}</p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <Input.Search
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          allowClear
          style={{ width: 420, maxWidth: '90vw' }}
          placeholder="Search by name, email, role, or system ID…"
        />
        <Dropdown
          trigger={['click']}
          dropdownRender={() => (
            <div
              style={{
                background: '#fff',
                borderRadius: 8,
                boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
                padding: '10px 14px',
                minWidth: 160,
              }}
            >
              <Checkbox.Group
                value={roleFilter}
                onChange={(vals) => setRoleFilter(vals as string[])}
                options={roleOptions}
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              />
              <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #f0f0f0', textAlign: 'right' }}>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0 }}
                  disabled={!roleFilter.length}
                  onClick={() => setRoleFilter([])}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}
        >
          <Button icon={<FilterOutlined />} type={roleFilter.length ? 'primary' : 'default'}>
            {roleFilter.length ? `Role (${roleFilter.length})` : 'Role'}
          </Button>
        </Dropdown>
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
