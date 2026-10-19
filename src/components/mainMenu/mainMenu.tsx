import { Dropdown, MenuProps, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { User } from '../../types';
import { signOut } from './signOut';
import Avatar from '../../layouts/header/avatar';
import { MENU_ICONS } from '../menuIcons';
import { exportElementToPNG, timestampedName } from '../../utils/exporters';
import { isStaff } from '../../utils/staff';
import { SITE_ORIGIN } from '../../utils/urls';

interface MainMenuProps {
  user: User;
}

const MainMenu = ({ user }: MainMenuProps) => {
  const navigate = useNavigate();

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
            icon: MENU_ICONS.admin,
            children: [
              {
                label: 'All Recordings',
                key: 'All-Experiments',
                icon: MENU_ICONS.recordings,
                onClick: () => navigate('/admin/experiments'),
              },
              { label: 'All Users', key: 'All-Users', icon: MENU_ICONS.users, onClick: () => navigate('/admin/users') },
              {
                label: 'Street View Reports',
                key: 'Street-View-Reports',
                icon: MENU_ICONS.report,
                onClick: () => navigate('/admin/streetview-reports'),
              },
            ],
          },
          { type: 'divider' },
        ] as NonNullable<MenuProps['items']>)
      : []),
    {
      label: 'Settings',
      key: 'Settings',
      icon: MENU_ICONS.settings,
      onClick: () => navigate('/settings'),
    },
    {
      label: 'Screenshot',
      key: 'Screenshot',
      icon: MENU_ICONS.screenshot,
      onClick: handleScreenshot,
    },
    {
      // Site-wide share moved off the homepage toolbar to declutter it; copies the canonical URL.
      label: 'Share this site',
      key: 'Share-Site',
      icon: MENU_ICONS.copyLink,
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(SITE_ORIGIN);
          message.success('Link copied');
        } catch {
          message.error('Could not copy the link');
        }
      },
    },
    { type: 'divider' },
    {
      label: 'About',
      key: 'About',
      icon: MENU_ICONS.info,
      onClick: () => navigate('/about'),
    },
    {
      label: 'Contact Us',
      key: 'Contact',
      icon: MENU_ICONS.contact,
      onClick: () => navigate('/contact'),
    },
    { type: 'divider' },
    {
      label: 'Sign Out',
      key: 'Sign-Out',
      icon: MENU_ICONS.signOut,
      onClick: signOut,
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
