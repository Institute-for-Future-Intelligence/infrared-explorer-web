import { Button, Divider, Dropdown, Form, Input, MenuProps, Modal } from 'antd';
import { CaretDownOutlined, CaretUpOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import useCommonStore from '../../../stores/common';
import { useEffect, useReducer, useState } from 'react';
import styled from 'styled-components';
import { addDoc, collection, doc, getDoc } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { TComment } from '../../../types';
import { deleteComment, updateComment } from '../../../services/experiments';
import OptionSVG from '../../../assets/option.svg?react';

interface Props {
  commentIds: string[];
  // Report the live comment count (top-level + replies) so the tab label stays in sync.
  onCountChange?: (count: number) => void;
}

interface InputCommentProps {
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  value: string;
}

const UserAvatar = styled.img<{ $size?: number }>`
  height: ${({ $size }) => $size ?? 32}px;
  width: ${({ $size }) => $size ?? 32}px;
  object-fit: cover;
  border-radius: 50%;
`;

const CommentTitleName = styled.span`
  padding-right: 8px;
  font-size: 12px;
  line-height: 18px;
  color: grey;
  font-weight: bold;
`;

const CommentTitleDate = styled.span`
  padding-right: 8px;
  font-size: 12px;
  line-height: 18px;
  color: #cccccc;
`;

const CommentDescription = styled.div`
  color: black;
  white-space: pre-wrap;
`;

const ActionLink = styled.a`
  font-size: 12px;
  margin-right: 12px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
`;

// telelab-style options trigger: the three-dot icon parked at the top-right of a
// comment row, revealed only while the row is hovered (see CommentRow / hoverId).
const OptionTrigger = styled.span`
  position: absolute;
  top: 6px;
  right: 4px;
  cursor: pointer;
  line-height: 0;
`;

const OptionIcon = styled(OptionSVG)`
  height: 22px;
  width: 22px;
  fill: #a9a9a9;
  &:hover {
    fill: #595959;
  }
`;

// position: relative so the absolutely-placed OptionTrigger anchors to each row.
// padding-right reserves a permanent gutter for the ⋮ so it never overlaps the
// date line — and, being always present, the hover-revealed icon causes no shift.
const CommentRow = styled.div`
  display: flex;
  gap: 8px;
  padding: 8px 28px 8px 0;
  position: relative;
`;

const { TextArea } = Input;

const InputComment = ({ onChange, onSubmit, value }: InputCommentProps) => (
  <>
    <Form.Item>
      <TextArea
        autoSize={{ minRows: 2, maxRows: 5 }}
        onChange={onChange}
        value={value}
        placeholder={'Add a comment...'}
      />
    </Form.Item>
    <Form.Item>
      <Button htmlType="submit" onClick={onSubmit} type="primary" style={{ float: 'right' }}>
        Add
      </Button>
    </Form.Item>
  </>
);

const CommentAvatar = ({ userId, size }: { userId: string; size?: number }) => {
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    // Public profile slice is readable by anyone; the private users/{id} doc is owner-only.
    getDoc(doc(firebaseDatabase, `usersPublic/${userId}`))
      .then((snap) => {
        const data = snap.data() as any;
        if (data?.avatar) setAvatar(data.avatar);
      })
      .catch(() => {});
  }, [userId]);

  return avatar ? <UserAvatar src={avatar} $size={size} /> : null;
};

const CommentList = ({ commentIds, onCountChange }: Props) => {
  const { expId } = useParams();
  const user = useCommonStore((state) => state.user);
  const commentMap = useCommonStore.getState().commentMap;

  const [localIds, setLocalIds] = useState<string[]>([]);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  // Which comment row the cursor is over — only that row shows its options (⋮).
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Top-level ids whose replies are collapsed; default is expanded (telelab behaviour).
  const [hiddenReplies, setHiddenReplies] = useState<Set<string>>(new Set());
  const [, forceRefresh] = useReducer((x) => x + 1, 0);

  const toggleReplies = (id: string) =>
    setHiddenReplies((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const all = [...commentIds, ...localIds]
    .filter((id) => !deletedIds.has(id))
    .map((id) => commentMap.get(id))
    .filter((c): c is TComment => !!c);

  const topLevel = all.filter((c) => !c.replyTo).reverse(); // newest first
  const repliesByParent = new Map<string, TComment[]>();
  all.forEach((c) => {
    if (c.replyTo) repliesByParent.set(c.replyTo, [...(repliesByParent.get(c.replyTo) ?? []), c]);
  });

  // Keep the tab label's count in sync after add / delete / reply.
  const count = all.length;
  useEffect(() => {
    onCountChange?.(count);
  }, [count, onCountChange]);

  const writeComment = async (content: string, replyTo?: string) => {
    if (!user || !expId) return;
    const payload: Record<string, unknown> = {
      senderId: user.id,
      senderName: user.displayName ?? '',
      senderAvatar: user.avatar ?? '',
      content,
      date: new Date().toLocaleString(),
    };
    if (replyTo) payload.replyTo = replyTo;
    const ref = await addDoc(collection(firebaseDatabase, `experiments/${expId}/comments`), payload);
    useCommonStore.getState().setComment(ref.id, { ...payload, id: ref.id } as TComment);
    setLocalIds((ids) => [...ids, ref.id]);
  };

  const onSubmit = async () => {
    const content = text.trim();
    if (!user || !expId || !content || submitting) return;
    setSubmitting(true);
    try {
      await writeComment(content);
      setText('');
    } catch (e) {
      console.error('failed to add comment', e);
    } finally {
      setSubmitting(false);
    }
  };

  const onReplySubmit = async (parentId: string) => {
    const content = replyText.trim();
    if (!content) return;
    try {
      await writeComment(content, parentId);
      setReplyingTo(null);
      setReplyText('');
    } catch (e) {
      console.error('failed to reply', e);
    }
  };

  const onDelete = (id: string) => {
    if (!expId) return;
    Modal.confirm({
      title: 'Delete this comment?',
      icon: <ExclamationCircleOutlined />,
      content: 'Replies to this comment will also be removed.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteComment(expId, id);
          setDeletedIds((s) => new Set(s).add(id));
        } catch (e) {
          console.error('failed to delete comment', e);
        }
      },
    });
  };

  const onEditSave = async (id: string) => {
    const content = editText.trim();
    if (!expId || !content) return;
    try {
      await updateComment(expId, id, content);
      const existing = commentMap.get(id);
      if (existing) useCommonStore.getState().setComment(id, { ...existing, content });
      setEditingId(null);
      forceRefresh();
    } catch (e) {
      console.error('failed to edit comment', e);
    }
  };

  const renderComment = (comment: TComment, isTopLevel: boolean) => {
    const isOwn = !!user && comment.senderId === user.id;
    const replies = repliesByParent.get(comment.id) ?? [];
    const repliesShown = !hiddenReplies.has(comment.id);
    const isEditing = editingId === comment.id;

    // Edit + Delete folded into one ⋮ menu, per request and telelab's optionMenu.
    const optionItems: MenuProps['items'] = [
      {
        key: 'edit',
        label: 'Edit',
        onClick: () => {
          setEditingId(comment.id);
          setEditText(comment.content);
        },
      },
      {
        key: 'delete',
        label: <span style={{ color: 'red' }}>Delete</span>,
        onClick: () => onDelete(comment.id),
      },
    ];

    return (
      <CommentRow
        key={comment.id}
        // onMouseOver bubbles; stopPropagation lets a hovered reply win over its
        // parent so only the innermost row reveals its ⋮ (telelab hoverID trick).
        onMouseOver={(e) => {
          e.stopPropagation();
          setHoverId(comment.id);
        }}
        onMouseLeave={() => setHoverId((id) => (id === comment.id ? null : id))}
      >
        <CommentAvatar userId={comment.senderId} size={isTopLevel ? 32 : 24} />
        <div style={{ flex: 1 }}>
          <div>
            <CommentTitleName>{comment.senderName}</CommentTitleName>
            <CommentTitleDate>{comment.date}</CommentTitleDate>
          </div>

          {isEditing ? (
            <div>
              <TextArea
                autoSize={{ minRows: 1, maxRows: 5 }}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
              />
              <div style={{ marginTop: 4 }}>
                <Button size="small" type="primary" onClick={() => onEditSave(comment.id)}>
                  Save
                </Button>
                <Button size="small" style={{ marginLeft: 8 }} onClick={() => setEditingId(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <CommentDescription>{comment.content}</CommentDescription>
          )}

          {!isEditing && (
            <div style={{ marginTop: 2 }}>
              {isTopLevel && user && (
                <ActionLink
                  onClick={() => {
                    setReplyingTo(comment.id);
                    setReplyText('');
                  }}
                >
                  Reply
                </ActionLink>
              )}
              {isTopLevel && replies.length > 0 && (
                <ActionLink onClick={() => toggleReplies(comment.id)}>
                  {repliesShown ? 'Hide' : 'View'} {replies.length > 1 ? 'replies' : 'reply'}
                  {repliesShown ? <CaretUpOutlined /> : <CaretDownOutlined />}
                </ActionLink>
              )}
            </div>
          )}

          {replyingTo === comment.id && (
            <div style={{ marginTop: 4 }}>
              <TextArea
                autoSize={{ minRows: 1, maxRows: 4 }}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Reply..."
              />
              <div style={{ marginTop: 4 }}>
                <Button size="small" type="primary" onClick={() => onReplySubmit(comment.id)}>
                  Reply
                </Button>
                <Button size="small" style={{ marginLeft: 8 }} onClick={() => setReplyingTo(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {isTopLevel && repliesShown && (
            // Replies indent on the left via the parent's content column, but the
            // negative right margin cancels the parent row's 28px ⋮ gutter so reply
            // rows share the same right edge — keeping every ⋮ on one vertical line.
            <div style={{ marginRight: -28 }}>{replies.map((reply) => renderComment(reply, false))}</div>
          )}
        </div>

        {isOwn && !isEditing && hoverId === comment.id && (
          <Dropdown menu={{ items: optionItems }} trigger={['click']} placement="bottomRight">
            <OptionTrigger onClick={(e) => e.stopPropagation()}>
              <OptionIcon />
            </OptionTrigger>
          </Dropdown>
        )}
      </CommentRow>
    );
  };

  return (
    <div>
      {topLevel.map((comment) => renderComment(comment, true))}

      <Divider />

      {user && user.avatar ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <UserAvatar src={user.avatar} />
          <div style={{ flex: 1 }}>
            <InputComment onChange={(e) => setText(e.target.value)} onSubmit={onSubmit} value={text} />
          </div>
        </div>
      ) : (
        <div>Please sign in to comment.</div>
      )}
    </div>
  );
};

export default CommentList;
