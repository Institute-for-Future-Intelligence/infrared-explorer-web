import { Link, useLocation } from 'react-router-dom';
import { RightOutlined } from '@ant-design/icons';
import useCommonStore, { NavCrumb } from '../../stores/common';
import { Experiment } from '../../types';

const HOME: NavCrumb = { label: 'Home', to: '/' };

/**
 * The desktop analyzer's breadcrumb line, between the header card and the player: how you got here.
 * Home, then the page this experiment was opened from — My Experiments, History, a class, someone's
 * profile, another experiment (after the list that chain of experiments started on) — each a link back to
 * exactly that page. Opened directly (a shared link), it's just Home. The experiment itself isn't a step:
 * its title heads the workspace right beside this line. The trail is recorded as you navigate
 * (useNavTrailRecorder); Back / Forward bring each visit's own trail back with it.
 */
const Breadcrumbs = ({ experiment }: { experiment: Experiment }) => {
  const { key } = useLocation();
  const trail = useCommonStore((state) => state.navTrails.get(key));
  // A profile page only knows it's "User Profile"; when it's this experiment's author's, name them.
  const crumbs = [
    HOME,
    ...(trail ?? []).map((crumb) =>
      crumb.ownerId && crumb.ownerId === experiment.ownerId && experiment.author
        ? { ...crumb, label: experiment.author }
        : crumb,
    ),
  ];

  return (
    <nav className="analyzer-crumbs" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((crumb, i) => (
          <li key={i}>
            {i > 0 && <RightOutlined className="analyzer-crumbs-sep" aria-hidden />}
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
