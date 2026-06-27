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

type NavItem = { key: string; icon: ReactNode; label: string };

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
        { key: '/myExperimentsList', icon: <ExperimentOutlined />, label: 'My Experiments' },
        { key: '/classroom', icon: <TeamOutlined />, label: 'My Classes' },
        { key: '/recent', icon: <ClockCircleOutlined />, label: 'History' },
        { key: '/raw', icon: <DatabaseOutlined />, label: 'Raw Data' },
        { key: '/trash', icon: <DeleteOutlined />, label: 'Trash' },
      );
    }
    const result: NavItem[][] = [
      main,
      [
        { key: '/about', icon: <InfoCircleOutlined />, label: 'About' },
        { key: '/contact', icon: <MailOutlined />, label: 'Contact Us' },
      ],
    ];
    // Admin group — telelab parity. Only @intofuture.org staff see it; firestore.rules enforces it.
    if (user && isStaff(user)) {
      result.push([
        { key: '/admin/experiments', icon: <ProfileOutlined />, label: 'All Experiments' },
        { key: '/admin/users', icon: <UsergroupAddOutlined />, label: 'All Users' },
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
                <span className="nav-label">{item.label}</span>
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
