import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Empty, Input, Modal, Select, Tag, Typography, message } from 'antd';
import { PlusOutlined, EditOutlined, PushpinOutlined, DeleteOutlined, DownloadOutlined } from '@ant-design/icons';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { firebaseDatabase } from '../../services/firebase';
import { ExperimentDoc, User, Visibility } from '../../types';
import Card from '../card/card';
import CardListWrapper from '../card/cardListWrapper';
import { ShowcaseItem } from '../../classroom/types';
import {
  copyMaterialToWorkspace,
  postMaterialToShowcase,
  removeShowcaseItem,
  renameShowcaseItem,
  setShowcasePinned,
  subscribeShowcase,
} from '../../classroom/classroomApi';

type ExperimentCard = ExperimentDoc & { id: string };

/** Teacher-only modal to publish one of their own experiments as class material. */
const PostMaterialModal = ({
  classId,
  user,
  open,
  onClose,
}: {
  classId: string;
  user: User;
  open: boolean;
  onClose: () => void;
}) => {
  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    getDocs(
      query(collection(firebaseDatabase, 'experiments'), where('ownerId', '==', user.id), where('trash', '==', false)),
    ).then((snap) => {
      const docs = snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id }));
      docs.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
      setExperiments(docs);
    });
  }, [open, user.id]);

  const handleOk = async () => {
    if (!selected) {
      message.warning('Please select an experiment');
      return;
    }
    const exp = experiments.find((e) => e.id === selected);
    if (!exp) return;
    try {
      setLoading(true);
      await postMaterialToShowcase(classId, user, {
        id: exp.id,
        displayName: exp.displayName,
        thumbnailURL: exp.thumbnailURL,
        recordingId: exp.recordingId,
        sourceType: exp.sourceType,
        visibility: exp.visibility as Visibility,
      });
      message.success('Published as teaching material');
      setSelected(undefined);
      onClose();
    } catch (err) {
      message.error((err as { message?: string }).message || 'Failed to publish');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Post material"
      open={open}
      confirmLoading={loading}
      onOk={handleOk}
      okText="Post"
      onCancel={onClose}
      destroyOnHidden
    >
      {experiments.length === 0 ? (
        <Empty description="You don't have any experiments yet." />
      ) : (
        <Select
          showSearch
          style={{ width: '100%' }}
          placeholder="Select an experiment to publish"
          value={selected}
          onChange={setSelected}
          optionFilterProp="label"
          options={experiments.map((e) => ({ value: e.id, label: e.displayName || '(untitled)' }))}
        />
      )}
    </Modal>
  );
};

interface Props {
  classId: string;
  user: User;
  isTeacher: boolean;
  /** Student-only: copy a material into the workspace. */
  onCopyToWorkspace?: (material: ShowcaseItem) => void;
}

/** Teacher's teaching materials, shown above the assignments. Teacher edits; students copy. */
const MaterialsSection = ({ classId, user, isTeacher, onCopyToWorkspace }: Props) => {
  const navigate = useNavigate();
  const [items, setItems] = useState<ShowcaseItem[]>([]);
  const [postOpen, setPostOpen] = useState(false);
  const [renaming, setRenaming] = useState<ShowcaseItem | null>(null);
  const [renameText, setRenameText] = useState('');

  useEffect(() => subscribeShowcase(classId, (all) => setItems(all.filter((i) => i.kind === 'material'))), [classId]);

  const openRename = (item: ShowcaseItem) => {
    setRenaming(item);
    setRenameText(item.title);
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          Teaching materials
        </Typography.Title>
        {isTeacher && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setPostOpen(true)}>
            Post material
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <Empty
          description={
            isTeacher
              ? 'Publish your experiments as teaching materials for students to view and copy.'
              : "The teacher hasn't posted any materials yet."
          }
        />
      ) : (
        <CardListWrapper>
          {items.map((item) => (
            <div key={item.id} style={{ position: 'relative' }}>
              {item.pinned && (
                <Tag color="gold" style={{ position: 'absolute', top: 4, left: 4, zIndex: 1, margin: 0 }}>
                  Pinned
                </Tag>
              )}
              <Card
                id={item.expId}
                url={item.thumbnailURL}
                displayName={item.title}
                author={item.ownerName}
                createdAt={item.createdAt ?? null}
                onOpen={(id) => navigate(`/experiments/${id}`)}
                menuItems={
                  isTeacher
                    ? [
                        { key: 'rename', label: 'Rename', icon: <EditOutlined />, onClick: () => openRename(item) },
                        {
                          key: 'pin',
                          label: item.pinned ? 'Unpin' : 'Pin',
                          icon: <PushpinOutlined />,
                          onClick: () => setShowcasePinned(classId, item.id, !item.pinned),
                        },
                        {
                          key: 'remove',
                          label: 'Remove',
                          icon: <DeleteOutlined />,
                          danger: true,
                          onClick: () => removeShowcaseItem(classId, item.id),
                        },
                      ]
                    : undefined
                }
              />
              {/* Student: a one-click "copy to my workspace" download icon (top-right). */}
              {!isTeacher && (
                <div
                  title="Copy to my workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyToWorkspace?.(item);
                  }}
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    zIndex: 2,
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: 'rgba(0,0,0,0.55)',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <DownloadOutlined />
                </div>
              )}
            </div>
          ))}
        </CardListWrapper>
      )}

      <PostMaterialModal classId={classId} user={user} open={postOpen} onClose={() => setPostOpen(false)} />

      <Modal
        title="Rename material"
        open={!!renaming}
        onOk={async () => {
          if (renaming) await renameShowcaseItem(classId, renaming.id, renameText.trim() || renaming.title);
          setRenaming(null);
        }}
        okText="Save"
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} maxLength={200} />
      </Modal>
    </div>
  );
};

export default MaterialsSection;
