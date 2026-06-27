import { useMemo, type ReactNode } from 'react';
import {
  ArrowLeftOutlined,
  HomeOutlined,
  ExperimentOutlined,
  TeamOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  MailOutlined,
  UsergroupAddOutlined,
  ProfileOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import ifiLogo from '../../assets/ifi-logo.png';

// `short` is an optional terser label shown only in the collapsed rail, where the box is too narrow
// for multi-word labels to fit on one line (the icon already carries the meaning).
type NavItem = { key: string; icon: ReactNode; label: string; short?: string };

// Left navigation sidebar (YouTube-style). Expanded: icon + label inline with a full-width pill
// highlight. Collapsed: a narrow rail with the icon over a small label and a square highlight behind
// the icon. Holds all content navigation (account-only actions stay in the avatar dropdown); items
// are auth-gated and staff-gated.
const Sidebar = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useCommonStore((state) => state.user);
  const collapsed = useCommonStore((state) => state.sidebarCollapsed);

  // Items split into groups; a divider is drawn between groups.
  const groups = useMemo<NavItem[][]>(() => {
    const main: NavItem[] = [{ key: '/', icon: <HomeOutlined />, label: 'Home' }];
    if (user) {
      main.push(
        { key: '/myExperimentsList', icon: <ExperimentOutlined />, label: 'My Experiments', short: 'Expts' },
        { key: '/classroom', icon: <TeamOutlined />, label: 'My Classes', short: 'Classes' },
        { key: '/recent', icon: <ClockCircleOutlined />, label: 'History' },
        { key: '/raw', icon: <DatabaseOutlined />, label: 'Raw Data', short: 'Raw' },
        { key: '/trash', icon: <DeleteOutlined />, label: 'Trash' },
      );
    }
    const result: NavItem[][] = [
      main,
      [
        { key: '/about', icon: <InfoCircleOutlined />, label: 'About' },
        { key: '/contact', icon: <MailOutlined />, label: 'Contact Us', short: 'Contact' },
      ],
    ];
    // Admin group — telelab parity. Only @intofuture.org staff see it; firestore.rules enforces it.
    if (user && isStaff(user)) {
      result.push([
        { key: '/admin/experiments', icon: <ProfileOutlined />, label: 'All Experiments', short: 'All Exp' },
        { key: '/admin/users', icon: <UsergroupAddOutlined />, label: 'All Users', short: 'Users' },
      ]);
    }
    return result;
  }, [user]);

  return (
    <nav className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="sidebar-nav">
        {/* Back button — shown on every page except Home; returns to the previous page. */}
        {location.pathname !== '/' && (
          <div className="sidebar-group">
            <button className="nav-item" onClick={() => navigate(-1)} title="Back">
              <span className="nav-icon">
                <ArrowLeftOutlined />
              </span>
              <span className="nav-label">Back</span>
            </button>
          </div>
        )}
        {groups.map((group, gi) => (
          <div className="sidebar-group" key={gi}>
            {group.map((item) => (
              <button
                key={item.key}
                className={`nav-item ${location.pathname === item.key ? 'selected' : ''}`}
                onClick={() => navigate(item.key)}
                title={item.label}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{collapsed ? (item.short ?? item.label) : item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {/* Parent-org brand, moved out of the header to the bottom of the rail. */}
      <div className="sidebar-footer">
        <img
          src={ifiLogo}
          alt="Institute for Future Intelligence"
          title="Go to Institute for Future Intelligence"
          onClick={() => window.open('https://intofuture.org', '_blank')}
        />
      </div>
    </nav>
  );
};

export default Sidebar;
