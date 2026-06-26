import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Input, Modal, Select, Typography, message } from 'antd';
import { EditOutlined, SendOutlined, DeleteOutlined } from '@ant-design/icons';
import { User } from '../../types';
import Card from '../card/card';
import CardListWrapper from '../card/cardListWrapper';
import { Assignment, WorkspaceItem } from '../../classroom/types';
import {
  deleteWorkspaceItem,
  fetchAssignments,
  renameWorkspaceItem,
  submitExperimentById,
  subscribeWorkspace,
} from '../../classroom/classroomApi';

/** Pick an open assignment and submit the given workspace item to it. */
const SubmitItemModal = ({
  classId,
  user,
  item,
  onClose,
}: {
  classId: string;
  user: User;
  item: WorkspaceItem | null;
  onClose: () => void;
}) => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item) return;
    setSelected(undefined);
    fetchAssignments(classId).then((list) => setAssignments(list.filter((a) => a.open)));
  }, [item, classId]);

  const handleOk = async () => {
    if (!item || !selected) {
      message.warning('Please select an assignment');
      return;
    }
    try {
      setLoading(true);
      await submitExperimentById(classId, selected, user, item.expId);
      message.success('Submitted');
      onClose();
    } catch (err) {
      message.error((err as { message?: string }).message || 'Failed to submit');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Submit to assignment"
      open={!!item}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Submit"
      okButtonProps={{ disabled: !selected }}
      onCancel={onClose}
      destroyOnHidden
    >
      <Select
        style={{ width: '100%' }}
        placeholder="Select an assignment"
        value={selected}
        onChange={setSelected}
        notFoundContent="No open assignments in this class"
        options={assignments.map((a) => ({ value: a.id, label: a.title }))}
      />
    </Modal>
  );
};

interface Props {
  classId: string;
  user: User;
}

/** Student's private workspace: copies of teacher materials they edit, then submit. */
const WorkspaceSection = ({ classId, user }: Props) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [submitting, setSubmitting] = useState<WorkspaceItem | null>(null);
  const [renaming, setRenaming] = useState<WorkspaceItem | null>(null);
  const [renameText, setRenameText] = useState('');

  useEffect(() => subscribeWorkspace(classId, user.id, setItems), [classId, user.id]);

  return (
    <div style={{ marginBottom: 24 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        My workspace
      </Typography.Title>

      {items.length === 0 ? (
        <Empty description="Copy a material from “Teaching materials” above to your workspace, edit it, then submit it to an assignment." />
      ) : (
        <CardListWrapper>
          {items.map((item) => (
            <Card
              key={item.id}
              id={item.expId}
              url={item.thumbnailURL}
              displayName={item.title}
              createdAt={item.createdAt ?? null}
              onOpen={(id) => navigate(`/experiments/${id}`)}
              menuItems={[
                {
                  key: 'rename',
                  label: 'Rename',
                  icon: <EditOutlined />,
                  onClick: () => {
                    setRenaming(item);
                    setRenameText(item.title);
                  },
                },
                {
                  key: 'submit',
                  label: 'Submit to assignment',
                  icon: <SendOutlined />,
                  onClick: () => setSubmitting(item),
                },
                {
                  key: 'remove',
                  label: 'Remove from workspace',
                  icon: <DeleteOutlined />,
                  danger: true,
                  onClick: () => deleteWorkspaceItem(classId, item.id),
                },
              ]}
            />
          ))}
        </CardListWrapper>
      )}

      <SubmitItemModal classId={classId} user={user} item={submitting} onClose={() => setSubmitting(null)} />

      <Modal
        title="Rename"
        open={!!renaming}
        onOk={async () => {
          if (renaming)
            await renameWorkspaceItem(classId, renaming.id, renaming.expId, renameText.trim() || renaming.title);
          setRenaming(null);
        }}
        okText="Save"
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} maxLength={200} autoFocus />
      </Modal>
    </div>
  );
};

export default WorkspaceSection;
