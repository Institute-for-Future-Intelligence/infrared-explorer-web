import { Link, useLocation } from 'react-router-dom';
import { RightOutlined } from '@ant-design/icons';
import useCommonStore, { NavCrumb } from '../stores/common';

const HOME: NavCrumb = { label: 'Home', to: '/' };

type BreadcrumbsProps = {
  // Where the page puts the line (.analyzer-crumbs, the project page's .pp-crumbs).
  className: string;
  // Whose the experiment or project on screen is: a step that is their profile page is named after them.
  ownerId?: string | null;
  author?: string | null;
};

/**
 * The breadcrumb line of a desktop page that shows how you got to it: an experiment in the analyzer
 * (between the header card and the player) or an AI Project (over its panes). Home, then the page it was
 * opened from — My Experiments, History, a class, someone's profile, the AI Project list, an AI Project
 * (after the list it was opened from), another experiment (after the list and the project that chain of
 * experiments started on) — each a link back to exactly that page. Opened directly (a shared link), it's just Home. The experiment or project itself isn't a step:
 * its title heads the card right beside or under this line. The trail is recorded as you navigate
 * (useNavTrailRecorder); Back / Forward and a reload bring each visit's own trail back with it.
 */
const Breadcrumbs = ({ className, ownerId, author }: BreadcrumbsProps) => {
  const { key } = useLocation();
  const trail = useCommonStore((state) => state.navTrails.get(key));
  // A profile page only knows it's "User Profile"; when it's the owner's, name them.
  const crumbs = [
    HOME,
    ...(trail ?? []).map((crumb) =>
      crumb.ownerId && crumb.ownerId === ownerId && author ? { ...crumb, label: author } : crumb,
    ),
  ];

  return (
    <nav className={`crumbs ${className}`} aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => (
          <li key={i}>
            {i > 0 && <RightOutlined className="crumbs-sep" aria-hidden />}
            <Link to={crumb.to} title={crumb.label}>
              {crumb.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
};

export default Breadcrumbs;
