/*
 * A public project as Community draws it (the app repository's
 * docs/proposals/lab-project-sharing.md §9.3, and the app's
 * CommunityProjectCard): the shared ProjectCard with the owner (a link to
 * their profile when their id is known) and when it went public as the
 * byline, and a ⋮ with Open and View Author — the same two rows the
 * experiment cards' menus start with. A click opens /projects/<id>: a
 * public project opens without a token.
 *
 * TODO: Hide This Author / Report Project / Report Author (lab-project-sharing.md §9.4) — not in this phase.
 */

import { useNavigate } from 'react-router-dom';
import type { MenuProps } from 'antd';
import type { CommunityProject } from '../core/types';
import { ago } from '../format';
import { authorProfilePath } from '../../utils/helpers';
import ProjectCard from './ProjectCard';

const CommunityProjectCard = ({ project }: { project: CommunityProject }) => {
  const navigate = useNavigate();
  const open = () => navigate(`/projects/${encodeURIComponent(project.id)}`);
  const authorHref = authorProfilePath(project.owner.id ?? undefined, project.owner.name);
  const when = project.publicAt > 0 ? ago(project.publicAt) : '';
  const menuItems: MenuProps['items'] = [
    { key: 'open', label: 'Open', onClick: open },
    ...(authorHref ? [{ key: 'author', label: 'View Author', onClick: () => navigate(authorHref) }] : []),
  ];
  return (
    <ProjectCard
      id={project.id}
      title={project.title}
      model={project.model}
      coverUrl={project.coverUrl}
      takeCount={project.takeCount}
      menuItems={menuItems}
      onOpen={open}
      byline={
        <>
          {authorHref ? (
            <span
              role="link"
              tabIndex={0}
              title="View profile"
              className="card-author-link"
              onClick={(e) => {
                e.stopPropagation();
                navigate(authorHref);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  navigate(authorHref);
                }
              }}
            >
              {project.owner.name}
            </span>
          ) : (
            <span>{project.owner.name}</span>
          )}
          {when && <span title="When it was made public">{` · ${when}`}</span>}
        </>
      }
    />
  );
};

export default CommunityProjectCard;
