import { Dropdown, MenuProps, message } from 'antd';
import { User } from '../../types';
import SignOut from './signOut';
import Avatar from '../../layouts/header/avatar';
import { Link as ReactRouterLink } from 'react-router-dom';
import styled from 'styled-components';
import { exportElementToPNG, timestampedName } from '../../utils/exporters';
import { isStaff } from '../../utils/staff';

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

  // Avatar dropdown. Content navigation (My Experiments, Classes, Recent, Raw, Trash) lives in the
  // left sidebar; this menu keeps account actions, the About/Contact info pages, and — for
  // @intofuture.org staff — the admin pages (firestore.rules enforces the gate).
  const items: MenuProps['items'] = [
    ...(isStaff(user)
      ? ([
          {
            label: 'Admin',
            key: 'Admin',
            children: [
              { label: <Link to={`admin/experiments`}>All Experiments</Link>, key: 'All-Experiments' },
              { label: <Link to={`admin/users`}>All Users</Link>, key: 'All-Users' },
            ],
          },
          { type: 'divider' },
        ] as NonNullable<MenuProps['items']>)
      : []),
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
      label: <Link to={`about`}>About</Link>,
      key: 'About',
    },
    {
      label: <Link to={`contact`}>Contact Us</Link>,
      key: 'Contact',
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
