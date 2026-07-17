import { useMemo, type ReactNode } from 'react';
import {
  ArrowLeftOutlined,
  HomeOutlined,
  GlobalOutlined,
  ExperimentOutlined,
  TeamOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  RightOutlined,
  UserOutlined,
  IdcardOutlined,
} from '@ant-design/icons';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import useCommonStore from '../../stores/common';
import { useIsMobile } from '../../hooks/useIsMobile';
import ifiLogo from '../../assets/ifi-logo.png';

// `short` is an optional terser label shown only in the collapsed rail, where the box is too narrow
// for multi-word labels to fit on one line (the icon already carries the meaning).
// `header` marks a group-heading item ("Me ›"): same nav row, plus a trailing chevron in the
// expanded sidebar to signal it fronts the group below it. In the collapsed rail it renders as a
// plain icon item like its siblings (every item keeps its rail icon).
type NavItem = { key: string; icon: ReactNode; label: string; short?: string; header?: boolean };

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

  // Drawer mode = a full-label off-canvas overlay drawer instead of the in-flow (expandable / collapsed-
  // rail) sidebar. Used on mobile (every page) AND on the desktop Experiment Analyzer (YouTube-watch-page
  // style: the nav is hidden by default and pops out over the content). In drawer mode the desktop
  // `collapsed` flag is ignored; the drawer is shown/hidden via `mobileDrawerOpen`.
  const drawerMode = isMobile || !!matchPath('/experiments/:expId', location.pathname);

  // Navigating closes the drawer.
  const go = (key: string) => {
    navigate(key);
    if (drawerMode) setMobileDrawerOpen(false);
  };
  // Collapsed rail styling + short labels only apply to the in-flow desktop sidebar; the drawer always
  // shows full labels. The drawer slide is driven by the `sidebar-drawer-open` class.
  const railCollapsed = !drawerMode && collapsed;
  const navClassName = drawerMode
    ? `sidebar sidebar-drawer ${mobileDrawerOpen ? 'sidebar-drawer-open' : ''}`
    : `sidebar ${collapsed ? 'sidebar-collapsed' : ''}`;

  // Items split into groups; a divider is drawn between groups. Group 1 = global surfaces (Home);
  // group 2 (signed-in, YouTube-style) = the "Me" group: a clickable "Me ›" header fronting the
  // hub page, then My Profile (the public showcase) and the personal collections it aggregates —
  // the same rows, in the same order.
  const groups = useMemo<NavItem[][]>(() => {
    // Global content surfaces (everyone): the staff-curated Home, then the open Community feed.
    const main: NavItem[] = [
      { key: '/', icon: <HomeOutlined />, label: 'Home' },
      { key: '/community', icon: <GlobalOutlined />, label: 'Community' },
    ];
    if (!user) return [main];
    const me: NavItem[] = [
      { key: '/me', icon: <UserOutlined />, label: 'Me', header: true },
      { key: `/users/${user.id}`, icon: <IdcardOutlined />, label: 'My Profile', short: 'Profile' },
      { key: '/myExperimentsList', icon: <ExperimentOutlined />, label: 'My Experiments', short: 'Expts' },
      { key: '/classroom', icon: <TeamOutlined />, label: 'My Classes', short: 'Classes' },
      { key: '/raw', icon: <DatabaseOutlined />, label: 'Raw Data', short: 'Raw' },
      { key: '/recent', icon: <ClockCircleOutlined />, label: 'History' },
      { key: '/trash', icon: <DeleteOutlined />, label: 'Trash' },
    ];
    // About/Contact and the admin items (All Experiments / All Users) live in the avatar dropdown;
    // the sidebar holds content nav only. Order mirrors the /me hub's rows.
    return [main, me];
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
                if (drawerMode) setMobileDrawerOpen(false);
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
                {/* Group-heading chevron ("Me ›"); the rail has no room for it. */}
                {item.header && !railCollapsed && <RightOutlined className="nav-header-chevron" />}
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
