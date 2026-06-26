import { Dropdown, MenuProps, message } from 'antd';
import { User } from '../../types';
import SignOut from './signOut';
import Avatar from '../../layouts/header/avatar';
import { Link as ReactRouterLink } from 'react-router-dom';
import styled from 'styled-components';
import { isStaff } from '../../utils/staff';
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

  // Admin submenu — telelab parity. Only internal IFI staff (signed in with an @intofuture.org
  // email) see it; the same check is enforced in firestore.rules, so this is just the UI gate.
  const adminItems: MenuProps['items'] = isStaff(user)
    ? [
        {
          label: 'Admin',
          key: 'Admin',
          children: [
            {
              label: <Link to={`admin/experiments`}>List All Experiments</Link>,
              key: 'Admin-Experiments',
            },
            {
              label: <Link to={`admin/users`}>List All Users</Link>,
              key: 'Admin-Users',
            },
          ],
        },
        { type: 'divider' },
      ]
    : [];

  const items: MenuProps['items'] = [
    ...adminItems,
    {
      label: <Link to={`myExperimentsList`}>My Experiments</Link>,
      key: 'My-Experiments',
    },
    {
      label: <Link to={`classroom`}>My Classes</Link>,
      key: 'My-Classes',
    },
    {
      label: <Link to={`recent`}>Recent</Link>,
      key: 'Recent',
    },
    {
      label: <Link to={`raw`}>Raw Data</Link>,
      key: 'Raw',
    },
    {
      label: <Link to={`trash`}>Trash</Link>,
      key: 'Trash',
    },
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
