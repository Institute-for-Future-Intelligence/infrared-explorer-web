import { Dropdown, MenuProps } from 'antd';
import { User } from '../../types';
import SignOut from './signOut';
import Avatar from '../../layouts/header/avatar';
import { Link as ReactRouterLink } from 'react-router-dom';
import styled from 'styled-components';

interface MainMenuProps {
  user: User;
}

const Link = styled(ReactRouterLink)`
  font-weight: normal;
`;

const MainMenu = ({ user }: MainMenuProps) => {
  const items: MenuProps['items'] = [
    {
      label: <Link to={`myExperimentsList`}>My Experiments</Link>,
      key: 'My-Experiments',
    },
    {
      label: <SignOut />,
      key: 'Sign-Out',
    },
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']}>
      <div className="avatar-wrapper">
        <Avatar userPhotoURL={user.avatar} />
      </div>
    </Dropdown>
  );
};

export default MainMenu;
