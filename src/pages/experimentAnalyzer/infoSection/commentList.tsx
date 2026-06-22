import { Button, Divider, Form, Input, List } from 'antd';
import useCommonStore from '../../../stores/common';
import { useEffect, useState } from 'react';
import OptionSVG from '../../../assets/option.svg?react';
import styled from 'styled-components';
import { addDoc, collection, doc, getDoc } from 'firebase/firestore';
import { useParams } from 'react-router-dom';
import { firebaseDatabase } from '../../../services/firebase';
import { TComment } from '../../../types';

interface Props {
  commentIds: string[];
}

interface InputCommentProps {
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  value: string;
}

interface CommentAvatarProps {
  userId: string;
}

const StyledOptionSVG = styled(OptionSVG)`
  position: absolute;
  top: 0;
  right: 0;
  height: 25px;
  width: 25px;
  fill: #a9a9a9;
  cursor: pointer;
`;

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
  text-wrap: nowrap;
`;

const CommentTitleDate = styled.span`
  padding-right: 8px;
  font-size: 12px;
  line-height: 18px;
  color: #cccccc;
  text-wrap: nowrap;
`;

const CommentDescription = styled.span`
  color: black;
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

const CommentAvatar = ({ userId }: CommentAvatarProps) => {
  const [avatar, setAvatar] = useState<string | null>(null);

  const fetch = async (userId: string) => {
    // Public profile slice (displayName/avatar) is readable by anyone; the private
    // users/{id} doc is owner-only under the security rules.
    const docRef = doc(firebaseDatabase, `usersPublic/${userId}`);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      const user = docSnap.data() as any;
      if (user.avatar) {
        setAvatar(user.avatar);
      }
    }
  };

  useEffect(() => {
    fetch(userId);
  }, [userId]);

  if (avatar) {
    return <UserAvatar src={avatar} />;
  } else {
    return null;
  }
};

const CommentList = ({ commentIds }: Props) => {
  const { expId } = useParams();
  const user = useCommonStore((state) => state.user);
  const commentMap = useCommonStore.getState().commentMap;

  // Locally-added comment ids (so a new comment shows without a full refetch).
  const [localIds, setLocalIds] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const comments = [...commentIds, ...localIds]
    .map((id) => commentMap.get(id))
    .filter((c) => !!c)
    .reverse();

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const onSubmit = async () => {
    const content = text.trim();
    if (!user || !expId || !content || submitting) return;
    setSubmitting(true);
    try {
      const payload = {
        senderId: user.id,
        senderName: user.displayName ?? '',
        senderAvatar: user.avatar ?? '',
        content,
        date: new Date().toLocaleString(),
      };
      const ref = await addDoc(collection(firebaseDatabase, `experiments/${expId}/comments`), payload);
      useCommonStore.getState().setComment(ref.id, { ...payload, id: ref.id } as TComment);
      setLocalIds((ids) => [...ids, ref.id]);
      setText('');
    } catch (e) {
      console.error('failed to add comment', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <List
        itemLayout="horizontal"
        dataSource={comments}
        renderItem={(comment, index) => {
          const actions: React.ReactNode[] = [];
          if (index === hoveredIndex) {
            actions.push(<StyledOptionSVG />);
          }
          return (
            <List.Item
              onPointerEnter={() => setHoveredIndex(index)}
              onPointerLeave={() => setHoveredIndex(null)}
              actions={actions}
            >
              <List.Item.Meta
                avatar={<CommentAvatar userId={comment.senderId} />}
                title={
                  <>
                    <CommentTitleName>{comment.senderName}</CommentTitleName>
                    <CommentTitleDate>{comment.date}</CommentTitleDate>
                  </>
                }
                description={<CommentDescription>{comment.content}</CommentDescription>}
              />
            </List.Item>
          );
        }}
      />

      <Divider />

      {user && user.avatar ? (
        <List>
          <List.Item>
            <List.Item.Meta
              avatar={<UserAvatar src={user.avatar} />}
              title={<InputComment onChange={(e) => setText(e.target.value)} onSubmit={onSubmit} value={text} />}
            />
          </List.Item>
        </List>
      ) : (
        <div>Please sign in to comment.</div>
      )}
    </div>
  );
};

export default CommentList;
