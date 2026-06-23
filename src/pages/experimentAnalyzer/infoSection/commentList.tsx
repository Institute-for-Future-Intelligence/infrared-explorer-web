import { Button, Divider, Form, Input } from 'antd';
import useCommonStore from '../../../stores/common';
import { useEffect, useReducer, useState } from 'react';
import styled from 'styled-components';
import { addDoc, collection, doc, getDoc } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { TComment } from '../../../types';
import { deleteComment, updateComment } from '../../../services/experiments';

interface Props {
  commentIds: string[];
}

interface InputCommentProps {
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  value: string;
}

const UserAvatar = styled.img`
  height: 32px;
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

const CommentAvatar = ({ userId }: { userId: string }) => {
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

  return avatar ? <UserAvatar src={avatar} /> : null;
};

const CommentList = ({ commentIds }: Props) => {
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
  const [, forceRefresh] = useReducer((x) => x + 1, 0);

  const all = [...commentIds, ...localIds]
    .filter((id) => !deletedIds.has(id))
    .map((id) => commentMap.get(id))
    .filter((c): c is TComment => !!c);

  const topLevel = all.filter((c) => !c.replyTo).reverse(); // newest first
  const repliesByParent = new Map<string, TComment[]>();
  all.forEach((c) => {
    if (c.replyTo) repliesByParent.set(c.replyTo, [...(repliesByParent.get(c.replyTo) ?? []), c]);
  });

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

  const onDelete = async (id: string) => {
    if (!expId) return;
    try {
      await deleteComment(expId, id);
      setDeletedIds((s) => new Set(s).add(id));
    } catch (e) {
      console.error('failed to delete comment', e);
    }
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
    return (
      <div key={comment.id} style={{ display: 'flex', gap: 8, padding: '8px 0' }}>
        <CommentAvatar userId={comment.senderId} />
        <div style={{ flex: 1 }}>
          <div>
            <CommentTitleName>{comment.senderName}</CommentTitleName>
            <CommentTitleDate>{comment.date}</CommentTitleDate>
          </div>

          {editingId === comment.id ? (
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

          {editingId !== comment.id && (
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
              {isOwn && (
                <>
                  <ActionLink
                    onClick={() => {
                      setEditingId(comment.id);
                      setEditText(comment.content);
                    }}
                  >
                    Edit
                  </ActionLink>
                  <ActionLink style={{ color: 'red' }} onClick={() => onDelete(comment.id)}>
                    Delete
                  </ActionLink>
                </>
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

          {isTopLevel && (
            <div style={{ marginLeft: 24 }}>
              {(repliesByParent.get(comment.id) ?? []).map((reply) => renderComment(reply, false))}
            </div>
          )}
        </div>
      </div>
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
