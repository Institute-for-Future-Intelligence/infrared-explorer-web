import { useMemo, type ReactNode } from 'react';
import {
  ArrowLeftOutlined,
  HomeOutlined,
  ExperimentOutlined,
  TeamOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import useCommonStore from '../../stores/common';
import { useIsMobile } from '../../hooks/useIsMobile';
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
  const isMobile = useIsMobile();
  const mobileDrawerOpen = useCommonStore((state) => state.mobileDrawerOpen);
  const setMobileDrawerOpen = useCommonStore((state) => state.setMobileDrawerOpen);

  // On mobile the sidebar is a full-label off-canvas drawer (never the icon-rail), so it ignores the
  // desktop `collapsed` flag and is shown/hidden via `mobileDrawerOpen`. Navigating closes the drawer.
  const go = (key: string) => {
    navigate(key);
    if (isMobile) setMobileDrawerOpen(false);
  };
  // Collapsed rail styling + short labels only apply on desktop; the mobile drawer always shows full
  // labels. The drawer slide is driven by the `sidebar-drawer-open` class.
  const railCollapsed = !isMobile && collapsed;
  const navClassName = isMobile
    ? `sidebar sidebar-mobile ${mobileDrawerOpen ? 'sidebar-drawer-open' : ''}`
    : `sidebar ${collapsed ? 'sidebar-collapsed' : ''}`;

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
    // About/Contact and the admin items (All Experiments / All Users) moved to the avatar dropdown;
    // the sidebar holds content navigation only.
    return [main];
  }, [user]);

  return (
    <nav className={navClassName}>
      <div className="sidebar-nav">
        {/* Back button — shown on every page except Home; returns to the previous page. */}
        {location.pathname !== '/' && (
          <div className="sidebar-group">
            <button
              className="nav-item"
              onClick={() => {
                navigate(-1);
                if (isMobile) setMobileDrawerOpen(false);
              }}
              title="Back"
            >
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
                onClick={() => go(item.key)}
                title={item.label}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{railCollapsed ? (item.short ?? item.label) : item.label}</span>
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
