/*
 * AI Project (/projects) — the signed-in user's AI lab projects that are on
 * the cloud for the website: the ones made here (New Project), uploaded
 * from the app (Upload to Cloud) or shared from it. The app repository's
 * docs/proposals/ai-projects-web.md. All data comes through the app's
 * `labProject*` callables (labProjects/api.ts); a new project is made on
 * the server at once and its page opened (an empty one is deleted again
 * when that page is left, labProjects/discard.ts).
 *
 * A card's top-left badge says how the project is shared, as My Recordings'
 * cards have it (a click opens the Share panel).
 *
 * A card's ⋮ has the app's row menu (ProjectsScreen) less Upload to Cloud:
 * Open in new tab, Rename, Share…, Select and Delete Project. Select — or
 * the Select button in the heading — puts the list in multi-select, as My
 * Experiments has it (hooks/useMultiSelect): the whole card is the checkbox
 * and the selection bar shares the ticked projects (one tier for them all,
 * as the Share panel's) or deletes them, one at a time as the app does.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Modal, Spin, message, type MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { Check, ChevronDown, FlaskConical, Plus, Share2, Trash2 } from 'lucide-react';
import styled from 'styled-components';
import useCommonStore from '../../stores/common';
import { signIn } from '../../services/auth';
import { ensureUgcConsent } from '../../services/ugcConsent';
import EmptyState from '../../components/emptyState';
import { MENU_ICONS, MENU_ICON_SIZE } from '../../components/menuIcons';
import SelectionBar, { SelectButton } from '../../components/selectionBar';
import { useMultiSelect } from '../../hooks/useMultiSelect';
import {
  createProject,
  deleteProject,
  editProject,
  getProject,
  listProjects,
  shareProject,
} from '../../labProjects/api';
import { isEmptyProject, shownTitle } from '../../labProjects/core/empty';
import type { Project, ProjectSummary, ShareVisibility } from '../../labProjects/core/types';
import { ago, countProjects } from '../../labProjects/format';
import { cancelTurn } from '../../labProjects/runner';
import { dropBundle, updateBundle } from '../../labProjects/store';
import {
  DELETE_PROJECT_MESSAGE,
  DELETE_PROJECTS_MESSAGE,
  RenameProjectDialog,
} from '../../labProjects/components/ProjectDialogs';
import ShareBadge from '../../labProjects/components/ShareBadge';
import ShareDialog from '../../labProjects/components/ShareDialog';
import { SHARE_TIERS, TAKEN_DOWN } from '../../labProjects/shareTiers';
import { consequence } from '../../components/visibilityControl';
import type { Visibility } from '../../types';

const Page = styled.div`
  max-width: 1240px;
  margin: 0 auto;
  padding: 16px 24px 48px;

  .lp-head {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    margin-bottom: 18px;
  }
  .lp-head h1 {
    font-family: var(--ifi-font-display);
    font-size: 24px;
    font-weight: 600;
    color: var(--ifi-ink);
    margin: 0;
  }
  .lp-count {
    flex: 1;
    font-size: 13px;
    color: var(--ifi-text-tertiary);
  }
  .lp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
  }
  .lp-center {
    display: flex;
    justify-content: center;
    padding: 64px 0;
  }
  /* the selection bar takes the heading's place at its height (the shared band's own padding is for the full-width lists) */
  .select-bar {
    min-height: 56px;
    margin: -8px -8px 10px;
    padding: 8px;
  }
  @media (max-width: 480px) {
    padding: 12px 8px 40px;
  }
`;

const Card = styled.article`
  display: flex;
  flex-direction: column;
  padding: 0;
  border: 1px solid var(--ifi-stroke-1);
  border-radius: 12px;
  overflow: hidden;
  background: var(--ifi-panel);
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  transition:
    box-shadow 0.15s,
    transform 0.15s;

  &:hover {
    box-shadow: 0 6px 18px rgba(11, 16, 38, 0.1);
    transform: translateY(-1px);
  }
  &:focus-visible {
    outline: 2px solid var(--ifi-teal);
    outline-offset: 2px;
  }
  /* multi-select: the experiment card's look (App.css .card.is-selected) — a teal ring, a teal film over the cover, the corner's check filled */
  &.is-selecting {
    user-select: none;
  }
  &.is-selecting:hover .card-select-check {
    background: rgba(11, 16, 38, 0.72);
    color: rgba(255, 255, 255, 0.55);
  }
  &.is-selected {
    border-color: var(--ifi-teal);
    box-shadow: 0 0 0 1px var(--ifi-teal);
  }
  &.is-selected:hover {
    box-shadow:
      0 0 0 1px var(--ifi-teal),
      0 6px 18px rgba(11, 16, 38, 0.1);
  }
  &.is-selected .card-select-check {
    background: var(--ifi-teal-fill);
    border-color: var(--ifi-teal-fill);
    color: #fff;
  }
  &.is-selected .lp-cover::after {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 140, 140, 0.22);
    pointer-events: none;
  }
  /* every cover the site's 3:4 thumbnail, picture or not, so the titles below line up across a row */
  .lp-cover {
    position: relative;
    aspect-ratio: var(--ifi-thumb-ratio);
    overflow: hidden;
    background: var(--ifi-fill-1);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ifi-grey);
  }
  .lp-cover img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* the ⋮ (or, while selecting, the check) where the experiment card has it */
  .lp-corner {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 1;
    display: flex;
  }
  /* how it is shared, where the experiment card has its visibility badge */
  .lp-corner-tl {
    right: auto;
    left: 12px;
  }
  .lp-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px 14px;
  }
  .lp-title {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--ifi-ink);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .lp-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12.5px;
    color: var(--ifi-text-tertiary);
  }
  .lp-model {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lp-when {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
  }
  .lp-busy {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ifi-teal-dark);
  }
`;

const EMPTY_HINT =
  "Experiments you upload from the app appear here. In the app, open an experiment's menu and choose Upload to Cloud.";

const tierOf = (s: ProjectSummary): ShareVisibility => s.visibility ?? 'private';

const ProjectsPage = () => {
  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  const authReady = useCommonStore((state) => state.authReady);
  const uid = user?.id ?? null;
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const visible = useMemo(() => items ?? [], [items]);
  const sel = useMultiSelect(visible);
  const stopSelecting = sel.stop;

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await listProjects());
    } catch (e) {
      setItems([]);
      setError((e as Error)?.message ?? 'Could not load your experiments.');
    }
  }, []);
  useEffect(() => {
    stopSelecting();
    if (!uid) {
      setItems(null);
      return;
    }
    setItems(null);
    load();
  }, [uid, load, stopSelecting]);

  // New Project: made on the server at once (its page needs the id), then opened
  const create = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const p = await createProject();
      navigate(`/projects/${encodeURIComponent(p.id)}`);
    } catch (e) {
      message.error((e as Error)?.message ?? 'Could not create an experiment.');
      setCreating(false);
    }
  };

  const open = (id: string) => navigate(`/projects/${encodeURIComponent(id)}`);
  const patch = (id: string, fn: (s: ProjectSummary) => ProjectSummary) =>
    setItems((prev) => prev && prev.map((s) => (s.id === id ? fn(s) : s)));

  // ---------------------------------------------------------- a card's ⋮

  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const rename = async (title: string) => {
    if (!renaming) {
      return;
    }
    const p = await editProject(renaming.id, { title });
    patch(p.id, (s) => ({ ...s, title: p.title, updatedAt: p.updatedAt }));
    // a page this tab opened before keeps the project in the store
    updateBundle(p.id, (b) => ({ ...b, project: p }));
  };

  // Share…: the panel needs the whole project (its link), asked of the server first. The app opens the
  // project's page with the panel up instead; here the panel opens over the list.
  const [sharing, setSharing] = useState<Project | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const openShare = async (s: ProjectSummary) => {
    const hide = message.loading('Loading sharing options…', 0);
    try {
      const b = await getProject(s.id);
      if (isEmptyProject(b)) {
        // as the project's own menu has it: an empty project is not kept, so there is nothing to share
        message.info('There is nothing in this experiment to share yet.');
        return;
      }
      setSharing(b.project);
      setShareOpen(true);
    } catch (e) {
      message.error((e as Error)?.message ?? 'Could not load the sharing options.');
    } finally {
      hide();
    }
  };
  // The panel records the site's UGC terms consent on the first switch out of Private.
  const changeSharing = async (v: ShareVisibility) => {
    if (!sharing) {
      return;
    }
    const p = await shareProject(sharing.id, v);
    setSharing(p);
    patch(p.id, (s) => ({ ...s, visibility: p.share?.visibility ?? 'private', takenDown: p.share?.takenDown }));
    updateBundle(p.id, (b) => ({ ...b, project: p }));
  };

  // Gone from the server, then from this tab: its bundle, and a turn this tab was still driving.
  const removeOne = async (id: string) => {
    await deleteProject(id);
    cancelTurn(id);
    dropBundle(id);
  };
  const askDelete = (s: ProjectSummary) =>
    Modal.confirm({
      title: 'Delete experiment?',
      content: DELETE_PROJECT_MESSAGE,
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await removeOne(s.id);
          setItems((prev) => prev && prev.filter((x) => x.id !== s.id));
          message.success('Experiment deleted');
        } catch (e) {
          message.error((e as Error)?.message ?? 'Could not delete the experiment.');
        }
      },
    });

  const menuFor = (s: ProjectSummary): MenuProps['items'] => [
    {
      key: 'open',
      label: 'Open in new tab',
      icon: MENU_ICONS.open,
      onClick: () => window.open(`${window.location.origin}/projects/${encodeURIComponent(s.id)}`, '_blank'),
    },
    { key: 'rename', label: 'Rename', icon: MENU_ICONS.rename, onClick: () => setRenaming(s) },
    { key: 'share', label: 'Share…', icon: MENU_ICONS.share, onClick: () => openShare(s) },
    {
      key: 'select',
      label: 'Select',
      icon: MENU_ICONS.select,
      onClick: () => {
        sel.start();
        sel.toggle(s.id, false);
      },
    },
    { type: 'divider' },
    {
      key: 'delete',
      label: 'Delete Experiment',
      icon: MENU_ICONS.delete,
      danger: true,
      onClick: () => askDelete(s),
    },
  ];

  // ----------------------------------------------------- multi-select

  const [busy, setBusy] = useState(false);
  const idle = !busy && sel.chosen.length > 0;

  // Share: one tier for every ticked project, confirmed first. Public skips the ones staff took out of
  // Community (the server refuses those); an empty one is refused by the server and stays ticked.
  const shareSelected = (v: ShareVisibility) => {
    const changing = sel.chosen.filter((s) => tierOf(s) !== v);
    const targets = v === 'public' ? changing.filter((s) => !s.takenDown) : changing;
    const blocked = changing.length - targets.length;
    if (targets.length === 0) {
      if (blocked > 0) {
        message.info(blocked === 1 ? TAKEN_DOWN : 'Staff removed these experiments from Community.');
      }
      return;
    }
    const label = SHARE_TIERS.find((t) => t.key === v)?.label ?? v;
    const n = targets.length;
    const skipped =
      blocked > 0
        ? ` ${countProjects(blocked)} that staff removed from Community ${blocked === 1 ? 'stays' : 'stay'} as before.`
        : '';
    Modal.confirm({
      title: `Set ${n === 1 ? 'this experiment' : countProjects(n)} to ${label}?`,
      content: consequence('experiment', v as Visibility, n) + skipped,
      okText: `Set to ${label}`,
      cancelText: 'Cancel',
      onOk: async () => {
        if (!user) {
          return;
        }
        setBusy(true);
        const ids = targets.map((s) => s.id);
        const shared = new Map<string, Project>();
        const reasons = new Set<string>();
        try {
          // as the Share panel does: the first switch out of Private passes the site's UGC terms record
          if (v !== 'private' && targets.some((s) => tierOf(s) === 'private')) {
            await ensureUgcConsent(user.id);
          }
          const results = await Promise.allSettled(ids.map((id) => shareProject(id, v)));
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              shared.set(ids[i], r.value);
            } else {
              console.error('could not share project', ids[i], r.reason);
              reasons.add((r.reason as Error)?.message ?? '');
            }
          });
        } catch (e) {
          message.error((e as Error)?.message ?? 'Could not change the sharing.');
          return;
        } finally {
          setBusy(false);
        }
        setItems(
          (prev) =>
            prev &&
            prev.map((s) => {
              const p = shared.get(s.id);
              return p ? { ...s, visibility: p.share?.visibility ?? 'private', takenDown: p.share?.takenDown } : s;
            }),
        );
        shared.forEach((p) => updateBundle(p.id, (b) => ({ ...b, project: p })));
        // the ones that did not change stay ticked, to try again
        sel.settle(ids, new Set(shared.keys()));
        const failed = n - shared.size;
        // one reason for every failure (an empty project's "nothing to share yet") is worth showing
        const why = reasons.size === 1 ? [...reasons][0] : '';
        if (failed === 0) {
          message.success(`Set ${countProjects(n)} to ${label}`);
        } else if (shared.size > 0) {
          message.warning(
            `Set ${countProjects(shared.size)} to ${label}; ${failed} could not be changed.${why ? ` ${why}` : ''}`,
          );
        } else {
          message.error(why || 'Could not change the sharing.');
        }
      },
    });
  };
  // The tier every ticked project already has, if they agree — checkmarked in the picker.
  const commonTier =
    sel.chosen.length > 0 && sel.chosen.every((s) => tierOf(s) === tierOf(sel.chosen[0]))
      ? tierOf(sel.chosen[0])
      : undefined;
  const allTakenDown = sel.chosen.length > 0 && sel.chosen.every((s) => s.takenDown);
  const shareMenu: MenuProps['items'] = SHARE_TIERS.map((t) => {
    const Icon = t.icon;
    const off = t.key === 'public' && allTakenDown;
    return {
      key: t.key,
      icon: <Icon size={MENU_ICON_SIZE} />,
      disabled: off,
      label: (
        <span title={off ? TAKEN_DOWN : t.hint}>
          {t.label}
          {t.key === commonTier && <Check size={12} strokeWidth={3} style={{ marginLeft: 8, verticalAlign: -1 }} />}
        </span>
      ),
      onClick: () => shareSelected(t.key),
    };
  });

  const deleteSelected = () => {
    const ids = sel.chosen.map((s) => s.id);
    const n = ids.length;
    Modal.confirm({
      title: n === 1 ? 'Delete 1 experiment?' : `Delete ${n} experiments?`,
      content: n === 1 ? DELETE_PROJECT_MESSAGE : DELETE_PROJECTS_MESSAGE,
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        setBusy(true);
        const done = new Set<string>();
        try {
          // one at a time, as the app does: each delete is a whole project's documents and files on the server
          for (const id of ids) {
            try {
              await removeOne(id);
              done.add(id);
            } catch (e) {
              console.error('could not delete project', id, e);
            }
          }
        } finally {
          setBusy(false);
        }
        setItems((prev) => prev && prev.filter((x) => !done.has(x.id)));
        // the ones that did not go stay ticked, to try again
        sel.settle(ids, done);
        const failed = n - done.size;
        if (failed === 0) {
          message.success(`Deleted ${countProjects(n)}`);
        } else if (done.size > 0) {
          message.warning(`Deleted ${countProjects(done.size)}; ${failed} could not be deleted.`);
        } else {
          message.error(n === 1 ? 'Could not delete the experiment.' : 'Could not delete the experiments.');
        }
      },
    });
  };

  if (!authReady) {
    return (
      <Page>
        <div className="lp-center">
          <Spin />
        </div>
      </Page>
    );
  }
  if (!user) {
    return (
      <Page>
        <EmptyState
          image={<FlaskConical size={64} strokeWidth={1.25} color="var(--ifi-teal)" />}
          title="Sign in to see your experiments"
          hint={EMPTY_HINT}
          action={{ label: 'Sign In', onClick: () => signIn().catch(() => undefined) }}
        />
      </Page>
    );
  }
  return (
    <Page>
      {sel.selecting ? (
        <SelectionBar sel={sel}>
          <Dropdown trigger={['click']} placement="bottomRight" disabled={!idle} menu={{ items: shareMenu }}>
            <button type="button" className="list-btn" disabled={!idle} aria-haspopup="menu">
              <Share2 size={15} aria-hidden />
              Share
              <ChevronDown size={14} aria-hidden />
            </button>
          </Dropdown>
          <button type="button" className="list-btn is-danger" onClick={deleteSelected} disabled={!idle}>
            <Trash2 size={15} aria-hidden />
            Delete
          </button>
        </SelectionBar>
      ) : (
        <div className="lp-head">
          <h1>My Experiments</h1>
          <span className="lp-count">{items && items.length > 0 ? countProjects(items.length) : ''}</span>
          {items && items.length > 0 && <SelectButton onClick={sel.start} />}
          <Button type="primary" icon={<Plus size={16} />} loading={creating} onClick={create}>
            New Experiment
          </Button>
        </div>
      )}
      {items == null ? (
        <div className="lp-center">
          <Spin />
        </div>
      ) : error ? (
        <EmptyState
          title="Could not load your experiments"
          hint={error}
          action={{ label: 'Try Again', onClick: load }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          image={<FlaskConical size={64} strokeWidth={1.25} color="var(--ifi-teal)" />}
          title="No experiments here yet"
          hint={`Start one with New Experiment, or upload one from the app. ${EMPTY_HINT}`}
          action={{ label: 'New Experiment', onClick: create }}
        />
      ) : (
        <div className="lp-grid">
          {items.map((p) => {
            const picked = sel.selecting && sel.selected.has(p.id);
            // while selecting, the whole card is the checkbox (Shift takes in a run of cards)
            const activate = (range: boolean) => (sel.selecting ? sel.toggle(p.id, range) : open(p.id));
            return (
              <Card
                key={p.id}
                className={`${sel.selecting ? 'is-selecting' : ''}${picked ? ' is-selected' : ''}`}
                role={sel.selecting ? 'checkbox' : 'link'}
                aria-checked={sel.selecting ? picked : undefined}
                aria-label={shownTitle(p.title)}
                tabIndex={0}
                onClick={(e) => activate(e.shiftKey)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    activate(e.shiftKey);
                  }
                }}
              >
                <div className="lp-cover">
                  {p.coverUrl ? (
                    <img src={p.coverUrl} alt="" loading="lazy" />
                  ) : (
                    <FlaskConical size={40} strokeWidth={1.25} />
                  )}
                  {/* while selecting, a click on it ticks the card like the rest of it */}
                  <div className="lp-corner lp-corner-tl">
                    <ShareBadge
                      visibility={p.visibility}
                      takenDown={p.takenDown}
                      onClick={sel.selecting ? undefined : () => openShare(p)}
                    />
                  </div>
                  <div className="lp-corner">
                    {sel.selecting ? (
                      <span className="card-select-check" aria-hidden>
                        <Check size={14} strokeWidth={3} />
                      </span>
                    ) : (
                      // the menu opens in a portal, whose clicks and keys still bubble to the card here
                      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <Dropdown menu={{ items: menuFor(p) }} trigger={['click']} placement="bottomRight">
                          <button type="button" className="card-menu-btn" title="Options" aria-label="Options">
                            <MoreOutlined />
                          </button>
                        </Dropdown>
                      </div>
                    )}
                  </div>
                </div>
                <div className="lp-body">
                  <div className="lp-title">{shownTitle(p.title)}</div>
                  {/* the model, not the status (user decision 2026-10-16, as on the Community card); the time
                      always on a line of its own, and no excerpt of the last message */}
                  <div className="lp-meta">
                    {p.model && <div className="lp-model">{p.model}</div>}
                    <div className="lp-when">
                      <span>Updated {ago(p.updatedAt)}</span>
                      {p.busy && (
                        <span className="lp-busy">
                          <Spin size="small" />
                          Working…
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <RenameProjectDialog
        open={renaming != null}
        initial={renaming?.title ?? ''}
        onClose={() => setRenaming(null)}
        onRename={rename}
      />
      {sharing && (
        <ShareDialog
          open={shareOpen}
          project={sharing}
          onClose={() => setShareOpen(false)}
          onVisibility={changeSharing}
        />
      )}
    </Page>
  );
};

export default ProjectsPage;
