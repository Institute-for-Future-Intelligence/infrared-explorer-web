import { Avatar as AntAvatar, Button, Dropdown, Form, Input, MenuProps, Modal } from 'antd';
import { CaretDownOutlined, CaretUpOutlined, ExclamationCircleOutlined, UserOutlined } from '@ant-design/icons';
import useCommonStore from '../../../stores/common';
import { useEffect, useReducer, useState } from 'react';
import styled from 'styled-components';
import { addDoc, collection, doc, getDoc } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { TComment } from '../../../types';
import { deleteComment, updateComment } from '../../../services/experiments';
import { signIn } from '../../../services/auth';
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
  submitting: boolean;
}

// Deterministic background for the initial-based fallback avatar, so a given commenter always gets
// the same (distinguishable) colour rather than a flat grey.
const AVATAR_COLORS = ['#1677ff', '#52c41a', '#fa8c16', '#eb2f96', '#722ed1', '#13c2c2', '#fa541c', '#2f54eb'];
const colorFor = (key: string) =>
  AVATAR_COLORS[Math.abs([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % AVATAR_COLORS.length];

// One avatar treatment everywhere: the profile photo when there is one, otherwise the name's initial
// on a stable colour (and a generic person icon if there's no name either). Replaces the old bare
// <img>, which simply rendered nothing when a user had no avatar.
const Avatar = ({
  src,
  name,
  colorKey,
  size = 32,
}: {
  src?: string | null;
  name?: string;
  colorKey: string;
  size?: number;
}) => {
  const initial = name?.trim().charAt(0).toUpperCase();
  return (
    <AntAvatar
      size={size}
      src={src || undefined}
      icon={!src && !initial ? <UserOutlined /> : undefined}
      style={{ flexShrink: 0, ...(src ? {} : { backgroundColor: colorFor(colorKey || name || '?') }) }}
    >
      {!src ? initial : null}
    </AntAvatar>
  );
};

const CommentTitleName = styled.span`
  padding-right: 8px;
  font-size: 13px;
  line-height: 18px;
  color: var(--ifi-text-secondary); /* was 'grey' (#808080, ~3.95:1, below WCAG AA) */
  font-weight: bold;
`;

const CommentTitleDate = styled.span`
  padding-right: 8px;
  font-size: 13px;
  line-height: 18px;
  color: var(--ifi-text-tertiary); /* was #cccccc (~1.6:1, effectively invisible) */
`;

const CommentDescription = styled.div`
  color: black;
  white-space: pre-wrap;
  word-break: break-word;

  a {
    color: var(--ifi-teal-dark);
    text-decoration: underline;
  }
`;

// Turn bare URLs in comment text into clickable links that open in a new tab. Splitting on the
// matched URLs keeps the surrounding text (and its pre-wrap whitespace) intact. rel="noopener
// noreferrer" so the opened page can't reach back via window.opener.
const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const renderContentWithLinks = (content: string) =>
  // split() with a capturing group interleaves the matched URLs (odd indices) with the
  // surrounding plain text (even indices), preserving pre-wrap whitespace.
  content.split(URL_REGEX).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );

// Real <button> (not an <a> without href): keyboard-focusable, activates on Enter/Space, and in the
// tab order. Padding lifts the hit area past 24px; --ifi-teal-dark clears WCAG AA (~5.3:1) where the
// old inherited teal link colour did not (~3.3:1).
const ActionLink = styled.button`
  font-size: 13px;
  margin-right: 8px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 4px 2px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--ifi-teal-dark);
  &:hover {
    text-decoration: underline;
  }
`;

// The three-dot options trigger parked at the top-right of a comment row. A real <button> so it is
// focusable/operable by keyboard; CommentRow controls its visibility (hover/focus/touch) via CSS.
const OptionTrigger = styled.button`
  position: absolute;
  top: 4px;
  right: 2px;
  border: none;
  background: none;
  padding: 2px;
  cursor: pointer;
  line-height: 0;
`;

const OptionIcon = styled(OptionSVG)`
  height: 22px;
  width: 22px;
  fill: var(--ifi-text-tertiary); /* >=3:1 for a UI glyph; was #a9a9a9 (~2.3:1) */
  ${OptionTrigger}:hover &,
  ${OptionTrigger}:focus-visible & {
    fill: var(--ifi-text-secondary);
  }
`;

// position: relative so the absolutely-placed OptionTrigger anchors to each row. padding-right
// reserves a permanent gutter for the ⋮ so it never overlaps the date line.
//
// The ⋮ is always in the DOM for the comment owner (so it is keyboard-reachable) but hidden until
// the row is hovered or focused; the direct-child combinator (> .comment-options) keeps a parent's
// hover from also revealing every nested reply's ⋮. On touch (no hover) it stays visible.
const CommentRow = styled.div<{ $topLevel?: boolean }>`
  display: flex;
  gap: 8px;
  padding: 8px 28px 8px 0;
  position: relative;

  /* A little extra vertical room on top-level comments so consecutive threads read as separate —
     spacing only, no divider line between them. Replies stay tight under their parent. */
  ${({ $topLevel }) => $topLevel && `padding-top: 6px; padding-bottom: 6px;`}

  > .comment-options {
    opacity: 0;
    transition: opacity 0.15s;
  }
  &:hover > .comment-options,
  &:focus-within > .comment-options {
    opacity: 1;
  }
  @media (hover: none) {
    > .comment-options {
      opacity: 1;
    }
  }
`;

const { TextArea } = Input;

const InputComment = ({ onChange, onSubmit, value, submitting }: InputCommentProps) => (
  <>
    <Form.Item>
      <TextArea
        autoSize={{ minRows: 2, maxRows: 5 }}
        onChange={onChange}
        value={value}
        placeholder={'Add a comment...'}
      />
    </Form.Item>
    <Form.Item style={{ marginBottom: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          htmlType="submit"
          onClick={onSubmit}
          type="primary"
          loading={submitting}
          disabled={!value.trim() || submitting}
        >
          Add
        </Button>
      </div>
    </Form.Item>
  </>
);

const CommentAvatar = ({ userId, name, size }: { userId: string; name?: string; size?: number }) => {
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

  // Falls back to the commenter's initial when they have no photo (was: render nothing).
  return <Avatar src={avatar} name={name} colorKey={userId} size={size} />;
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
      <CommentRow key={comment.id} $topLevel={isTopLevel}>
        <CommentAvatar userId={comment.senderId} name={comment.senderName} size={isTopLevel ? 32 : 24} />
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
            <CommentDescription>{renderContentWithLinks(comment.content)}</CommentDescription>
          )}

          {!isEditing && (
            <div style={{ marginTop: 2 }}>
              {isTopLevel && user && (
                <ActionLink
                  type="button"
                  onClick={() => {
                    setReplyingTo(comment.id);
                    setReplyText('');
                  }}
                >
                  Reply
                </ActionLink>
              )}
              {isTopLevel && replies.length > 0 && (
                <ActionLink type="button" aria-expanded={repliesShown} onClick={() => toggleReplies(comment.id)}>
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

        {/* Always rendered for the comment owner (so it's keyboard-reachable); CommentRow's CSS
            controls when it's visible (hover / focus-within / touch). */}
        {isOwn && !isEditing && (
          <Dropdown menu={{ items: optionItems }} trigger={['click']} placement="bottomRight">
            <OptionTrigger
              className="comment-options"
              type="button"
              aria-label="Comment options"
              onClick={(e) => e.stopPropagation()}
            >
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

      {/* The composer sits below the thread separated by whitespace only — no divider line. */}
      <div style={{ marginTop: 16 }}>
        {user ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <Avatar src={user.avatar} name={user.displayName ?? user.email ?? ''} colorKey={user.id} size={32} />
            <div style={{ flex: 1 }}>
              <InputComment
                onChange={(e) => setText(e.target.value)}
                onSubmit={onSubmit}
                value={text}
                submitting={submitting}
              />
            </div>
          </div>
        ) : (
          <div>
            <Button type="link" style={{ padding: 0 }} onClick={() => signIn().catch((e) => console.error(e))}>
              Sign in
            </Button>{' '}
            to comment.
          </div>
        )}
      </div>
    </div>
  );
};

export default CommentList;
