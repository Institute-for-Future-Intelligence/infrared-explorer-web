/*
 * A public project as Community draws it (the app repository's
 * docs/proposals/lab-project-sharing.md §9.3, and the app's
 * CommunityProjectCard): the shared ProjectCard with the owner (a link to
 * their profile when their id is known) and when it went public as the
 * byline, and a ⋮ with Open in new tab and Save as… — the same rows, words
 * and icons as the recording cards' menus beside it. No View Author row
 * (user's call 2026-10-19): the byline's name already links to the profile.
 * A click opens /projects/<id>: a public project opens without a token.
 *
 * Save as… is the caller's (useSaveProjectCopy): not on one's own project
 * here, which the server refuses (its own Save as… is in the project's ⋮).
 *
 * TODO: Hide This Author / Report Project / Report Author (lab-project-sharing.md §9.4) — not in this phase.
 */

import { useNavigate } from 'react-router-dom';
import type { MenuProps } from 'antd';
import { ExternalLink, FolderPlus } from 'lucide-react';
import type { CommunityProject } from '../core/types';
import { shownTitle } from '../core/empty';
import { ago } from '../format';
import { authorProfilePath } from '../../utils/helpers';
import useCommonStore from '../../stores/common';
import { SAVE_AS_LABEL } from '../../components/saveCopy';
import ProjectCard from './ProjectCard';

interface Props {
  project: CommunityProject;
  /** Save as… (useSaveProjectCopy's `save`); the row is left out without it. */
  onSave?: (project: CommunityProject) => void;
}

const CommunityProjectCard = ({ project, onSave }: Props) => {
  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  const href = `/projects/${encodeURIComponent(project.id)}`;
  const open = () => navigate(href);
  const authorHref = authorProfilePath(project.owner.id ?? undefined, project.owner.name);
  const when = project.publicAt > 0 ? ago(project.publicAt) : '';
  // The owner's id is their mongoId, as User.id is.
  const own = !!user && !!project.owner.id && project.owner.id === user.id;
  const menuItems: MenuProps['items'] = [
    {
      key: 'open',
      label: 'Open in new tab',
      icon: <ExternalLink size={14} />,
      onClick: () => window.open(`${window.location.origin}${href}`, '_blank'),
    },
    ...(onSave && !own
      ? [
          {
            key: 'save',
            label: SAVE_AS_LABEL,
            icon: <FolderPlus size={14} />,
            onClick: () => onSave(project),
          },
        ]
      : []),
  ];
  return (
    <ProjectCard
      id={project.id}
      title={shownTitle(project.title)}
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
