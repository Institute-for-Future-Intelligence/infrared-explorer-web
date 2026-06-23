import { Avatar as AntAvatar } from 'antd';
import { UserOutlined } from '@ant-design/icons';

interface AvatarProps {
  userPhotoURL: string | null;
  displayName?: string | null;
  email?: string | null;
}

const getInitial = (displayName?: string | null, email?: string | null): string | null => {
  const source = displayName?.trim() || email?.trim();
  return source ? source.charAt(0).toUpperCase() : null;
};

const Avatar = ({ userPhotoURL, displayName, email }: AvatarProps) => {
  const initial = getInitial(displayName, email);

  return (
    <AntAvatar size={40} src={userPhotoURL || undefined} icon={initial ? undefined : <UserOutlined />}>
      {initial}
    </AntAvatar>
  );
};

export default Avatar;
