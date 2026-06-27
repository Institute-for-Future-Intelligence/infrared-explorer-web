import { Dropdown, MenuProps, message } from 'antd';
import { User } from '../../types';
import SignOut from './signOut';
import Avatar from '../../layouts/header/avatar';
import { Link as ReactRouterLink } from 'react-router-dom';
import styled from 'styled-components';
import { exportElementToPNG, timestampedName } from '../../utils/exporters';

interface MainMenuProps {
  user: User;
}

const Link = styled(ReactRouterLink)`
  font-weight: normal;
`;

const MainMenu = ({ user }: MainMenuProps) => {
  // Capture the whole page (header + content) to a PNG and download it. We wait a tick so the
  // dropdown has closed and isn't rasterized into the screenshot.
  const handleScreenshot = async () => {
    const el = document.querySelector<HTMLElement>('.app');
    if (!el) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      await exportElementToPNG(el, timestampedName('screenshot', 'png'));
    } catch (err) {
      console.error('Screenshot failed', err);
      message.error('Screenshot failed. Please try again.');
    }
  };

  // Account-only dropdown. Content navigation (My Experiments, Classes, Recent, Raw, Trash, About,
  // Contact, Admin) now lives in the left sidebar; the avatar menu keeps just account actions.
  const items: MenuProps['items'] = [
    {
      label: <Link to={`settings`}>Settings</Link>,
      key: 'Settings',
    },
    {
      label: 'Screenshot',
      key: 'Screenshot',
      onClick: handleScreenshot,
    },
    { type: 'divider' },
    {
      label: <SignOut />,
      key: 'Sign-Out',
    },
  ];

  return (
    <Dropdown menu={{ items }} trigger={['click']}>
      <div className="avatar-wrapper">
        <Avatar userPhotoURL={user.avatar} displayName={user.displayName} email={user.email} />
      </div>
    </Dropdown>
  );
};

export default MainMenu;
