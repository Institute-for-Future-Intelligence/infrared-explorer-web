/*
 * An AI project as a card in the site's grids and strips: the same 3:4 cell
 * as an experiment card (components/card/card.tsx), built on its classes
 * (.card, .card-media, .card-info, …) so it sits beside one in a CardStrip
 * or a CardListWrapper and takes the strip's paged width. The project's
 * newest picture is the cover (a night tile with the flask when it has
 * none), a "Project" tag in the top-left corner (after how it is shared,
 * on the owner's own grids), how many captures in the
 * bottom-right pill, then the title, a byline the caller writes, and the
 * model that wrote the latest reply, in the experiment card's stats row
 * (the card names no status: user decision 2026-10-16). Community's card
 * (CommunityProjectCard.tsx, also mixed into the home page's "From the
 * community" row) draws with it; it follows the app's CommunityProjectCard,
 * which names no status either (user's call 2026-10-19).
 */

import { useState, type ReactNode } from 'react';
import { Dropdown, type MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { FlaskConical, Sparkles } from 'lucide-react';
import styled from 'styled-components';
import type { ShareVisibility } from '../core/types';
import ShareBadge from './ShareBadge';

const ProjectTag = styled.span`
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  background: rgba(11, 16, 38, 0.72);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  line-height: 1;
`;

const CoverEmpty = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ifi-grey, #8a8f9c);
`;

/** The model in the .card-stats row: a long name ends in an ellipsis instead of widening the card. */
const ModelStat = styled.span`
  min-width: 0;
  svg {
    flex: none;
  }
  .lp-model-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

/** Strip any HTML tags a title might carry, as the experiment card does. */
const extractText = (html: string) => html.replace(/<[^>]*>/g, '');

const ProjectCard = ({
  id,
  title,
  model,
  coverUrl,
  takeCount,
  byline,
  share,
  menuItems,
  onOpen,
}: {
  id: string;
  title: string;
  /** What the model that wrote the latest reply is called; the row is left off when it is not known. */
  model?: string;
  coverUrl: string | null;
  /** How many captures the project has; the pill is left off when it is not known or zero. */
  takeCount?: number;
  /** The line under the title (the owner and when, or when it was updated). */
  byline?: ReactNode;
  /** How it is shared, as a badge before the tag — the owner's own grids only; left off when absent. */
  share?: { visibility?: ShareVisibility; takenDown?: boolean };
  /** The ⋮ menu in the cover's top-right corner, as the experiment card has it. */
  menuItems?: MenuProps['items'];
  onOpen: (id: string) => void;
}) => {
  const [failed, setFailed] = useState(false);
  const name = extractText(title);
  const showCover = !!coverUrl && !failed;
  const captures =
    typeof takeCount === 'number' && takeCount > 0 ? `${takeCount} ${takeCount === 1 ? 'capture' : 'captures'}` : '';
  return (
    <article
      className="card"
      role="link"
      tabIndex={0}
      aria-label={name}
      onClick={() => onOpen(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(id);
        }
      }}
      style={{ cursor: 'pointer' }}
    >
      <div className="card-media">
        {showCover ? (
          <img className="card-media-img" src={coverUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <CoverEmpty aria-hidden>
            <FlaskConical size={36} strokeWidth={1.25} />
          </CoverEmpty>
        )}
        <div className="card-corner card-corner-tl">
          {share && <ShareBadge visibility={share.visibility} takenDown={share.takenDown} />}
          <ProjectTag>Experiment</ProjectTag>
        </div>
        {menuItems && menuItems.length > 0 && (
          <div className="card-corner card-corner-tr">
            <div onClick={(e) => e.stopPropagation()}>
              <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
                <MoreOutlined title="Options" className="card-menu-btn" />
              </Dropdown>
            </div>
          </div>
        )}
        {captures && <span className="card-duration">{captures}</span>}
        <div className="card-viewfinder" aria-hidden />
      </div>
      <div className="card-info">
        <h3 className="card-title">{name}</h3>
        {byline && <p className="card-byline">{byline}</p>}
        {model && (
          <p className="card-stats">
            <ModelStat className="card-stat" title="AI model">
              <Sparkles size={13} strokeWidth={1.75} aria-hidden />
              <span className="lp-model-name">{model}</span>
            </ModelStat>
          </p>
        )}
      </div>
    </article>
  );
};

export default ProjectCard;
