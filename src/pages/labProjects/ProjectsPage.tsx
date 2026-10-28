/*
 * AI Project (/projects) — the signed-in user's AI lab projects that are on
 * the cloud for the website: the ones made here (New Experiment), uploaded
 * from the app (Upload to Cloud) or shared from it. The app repository's
 * docs/proposals/ai-projects-web.md. All data comes through the app's
 * `labProject*` callables (labProjects/api.ts); a new project is made on
 * the server at once and its page opened (an empty one is deleted again
 * when that page is left, labProjects/discard.ts).
 *
 * Laid out as My Recordings (pages/myExperimentsList.tsx; user's call
 * 2026-10-28): the page's name in the header bar, the same toolbar band —
 * sort, sharing chips, search, Select, and here New Experiment — over the
 * same card grid (CardListWrapper + the shared ProjectCard, the recording
 * card's twin). A card's top-left badge says how the project is shared, as
 * My Recordings' cards have it (a click opens the Share panel).
 *
 * A card's ⋮ has the app's row menu (ProjectsScreen) less Upload to Cloud:
 * Open in new tab, Rename, Share…, Select and Delete Project. Select — or
 * the Select button in the toolbar — puts the list in multi-select, as My
 * Recordings has it (hooks/useMultiSelect): the whole card is the checkbox
 * and the selection bar shares the ticked projects (one tier for them all,
 * as the Share panel's) or deletes them, one at a time as the app does.
 *
 * Staff also get Admin › Add to / Remove from homepage showcase, as My
 * Recordings' cards have it (labProjectFeature). The server only features a
 * public project, so adding a private or unlinked one sets it Public first,
 * as featuring a recording does; a featured card carries the star badge.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dropdown, Modal, Spin, message, type MenuProps } from 'antd';
import { Check, ChevronDown, FlaskConical, Plus, Share2, Trash2 } from 'lucide-react';
import styled from 'styled-components';
import useCommonStore from '../../stores/common';
import { signIn } from '../../services/auth';
import { ensureUgcConsent } from '../../services/ugcConsent';
import EmptyState from '../../components/emptyState';
import CardListWrapper from '../../components/card/cardListWrapper';
import ChipMultiFilter, { type FilterChip } from '../../components/chipMultiFilter';
import ScrollRow from '../../components/scrollRow';
import ListSearch from '../../components/listSearch';
import SortMenu, { SORT_OPTIONS, type SortFields, type SortValue, compareSortFields } from '../../components/sortMenu';
import { MENU_ICONS, MENU_ICON_SIZE } from '../../components/menuIcons';
import SelectionBar, { SelectButton } from '../../components/selectionBar';
import BackToTop from '../../components/backToTop';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useMultiSelect } from '../../hooks/useMultiSelect';
import {
  createProject,
  deleteProject,
  editProject,
  getProject,
  listProjects,
  shareProject,
} from '../../labProjects/api';
import { buildFeatureMenuItem } from '../../components/featureControl';
import { changeProjectFeatured, shownFeatured, useShowcaseIds } from '../../labProjects/showcase';
import { isStaff } from '../../utils/staff';
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
import ProjectCard from '../../labProjects/components/ProjectCard';
import ShareDialog from '../../labProjects/components/ShareDialog';
import { SHARE_TIERS, TAKEN_DOWN } from '../../labProjects/shareTiers';
import { consequence } from '../../components/visibilityControl';
import type { Visibility } from '../../types';

/** A turn holds the project on the server: said after the time, in the byline. */
const Busy = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 10px;
  color: var(--ifi-teal-dark);
`;

const EMPTY_HINT =
  "Experiments you upload from the app appear here. In the app, open an experiment's menu and choose Upload to Cloud.";

const tierOf = (s: ProjectSummary): ShareVisibility => s.visibility ?? 'private';

// The orders that mean something for a project: it has no views, ratings or comments, and "By
// visibility" is the chips' job (My Recordings' sections are a recording thing).
const PROJECT_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key === 'newest' || o.key === 'updated' || o.key === 'title');

const TIER_RANK: Record<ShareVisibility, number> = { public: 0, unlisted: 1, private: 2 };

/** What the sort orders read off a project (components/sortMenu SortFields). */
const sortFieldsOf = (s: ProjectSummary): SortFields => ({
  createdMillis: s.createdAt,
  updatedMillis: s.updatedAt || s.createdAt,
  viewCount: 0,
  ratingAvg: 0,
  ratingCount: 0,
  commentCount: 0,
  title: shownTitle(s.title),
  visibilityRank: TIER_RANK[tierOf(s)],
});

/** Case-insensitive substring match over the title and the model, as ListSearch's matchesSearch over a recording. */
const matches = (s: ProjectSummary, term: string): boolean => {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  return [shownTitle(s.title), s.model].some((f) => (f ?? '').toLowerCase().includes(q));
};

const ProjectsPage = () => {
  const navigate = useNavigate();
  const user = useCommonStore((state) => state.user);
  const authReady = useCommonStore((state) => state.authReady);
  const uid = user?.id ?? null;
  const staff = isStaff(user);
  // Staff only: which of the list are in the homepage showcase (labProjects/showcase.ts)
  const showcase = useShowcaseIds(uid, staff);
  const isFeatured = (s: ProjectSummary) => shownFeatured(showcase.ids, s.id, tierOf(s), s.takenDown);
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // The sort and the sharing filter persist across visits (localStorage), as My Recordings'; the
  // search term stays transient. An empty filter = unfiltered ("All").
  const [sort, setSort] = usePersistentState<SortValue>('projects.sort', 'updated');
  const [filters, setFilters] = usePersistentState<string[]>('projects.filters', []);
  const [term, setTerm] = useState('');

  // Per-tier counts; the chips are only offered when the projects actually span 2+ tiers (filtering
  // by the single present tier would be a no-op), each labelled with its count.
  const tierCounts = useMemo(() => {
    const counts: Record<ShareVisibility, number> = { public: 0, unlisted: 0, private: 0 };
    for (const s of items ?? []) counts[tierOf(s)] += 1;
    return counts;
  }, [items]);
  const present = SHARE_TIERS.filter((t) => tierCounts[t.key] > 0);
  const chips: FilterChip[] =
    present.length >= 2
      ? present.map((t) => ({
          key: t.key,
          label: `${t.label} ${tierCounts[t.key]}`,
          icon: <t.icon size={14} strokeWidth={2} aria-hidden />,
        }))
      : [];
  const selectedTiers = filters.filter((f) => f in TIER_RANK);

  // The sharing filter + search, then the chosen order. Client-side over the loaded list; the ⋮ and
  // bulk mutations still target the full `items` list.
  const visible = useMemo(() => {
    const compare = compareSortFields(sort);
    return (items ?? [])
      .filter((s) => (selectedTiers.length === 0 || selectedTiers.includes(tierOf(s))) && matches(s, term))
      .sort((a, b) => compare(sortFieldsOf(a), sortFieldsOf(b)));
    // selectedTiers derives from `filters`; depend on it to avoid re-splitting churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filters, term, sort]);
  // Multi-select over the cards on screen. While selecting, the toolbar band gives way to the
  // selection bar, so the visible list can't change under the selection.
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

  // New Experiment: made on the server at once (its page needs the id), then opened
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

  // Admin › homepage showcase (staff); adding one that is not Public sets it Public first
  const changeFeatured = async (s: ProjectSummary, featured: boolean) => {
    if (!user) {
      return;
    }
    const r = await changeProjectFeatured(
      { id: s.id, visibility: tierOf(s), takenDown: s.takenDown },
      featured,
      user.id,
    );
    if (!r) {
      return;
    }
    showcase.mark(s.id, r.featured);
    const p = r.shared;
    if (p) {
      patch(p.id, (x) => ({ ...x, visibility: p.share?.visibility ?? 'private', takenDown: p.share?.takenDown }));
      updateBundle(p.id, (b) => ({ ...b, project: p }));
    }
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
    // Staff-only, grouped under "Admin" as on My Recordings' cards
    ...(staff
      ? [
          {
            key: 'admin',
            icon: MENU_ICONS.admin,
            label: 'Admin',
            children: [buildFeatureMenuItem(isFeatured(s), (next) => changeFeatured(s, next))],
          },
        ]
      : []),
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

  const spinner = (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 0' }}>
      <Spin />
    </div>
  );

  if (!authReady) {
    return <div className="my-experiments-page">{spinner}</div>;
  }
  if (!user) {
    return (
      <div className="my-experiments-page">
        <EmptyState
          image={<FlaskConical size={64} strokeWidth={1.25} color="var(--ifi-teal)" />}
          title="Sign in to see your experiments"
          hint={EMPTY_HINT}
          action={{ label: 'Sign In', onClick: () => signIn().catch(() => undefined) }}
        />
      </div>
    );
  }

  const renderBody = () => {
    if (items == null) return spinner;
    if (error) {
      return (
        <EmptyState
          title="Could not load your experiments"
          hint={error}
          action={{ label: 'Try Again', onClick: load }}
        />
      );
    }
    if (items.length === 0) {
      return (
        <EmptyState
          image={<FlaskConical size={64} strokeWidth={1.25} color="var(--ifi-teal)" />}
          title="No experiments here yet"
          hint={`Start one with New Experiment, or upload one from the app. ${EMPTY_HINT}`}
          action={{ label: 'New Experiment', onClick: create }}
        />
      );
    }
    if (visible.length === 0) {
      return (
        <EmptyState
          title="No experiments match"
          hint="Try clearing the filter or search to see all of them."
          action={{
            label: 'Clear filters',
            onClick: () => {
              setFilters([]);
              setTerm('');
            },
          }}
        />
      );
    }
    return (
      <CardListWrapper>
        {visible.map((p) => (
          <ProjectCard
            key={p.id}
            id={p.id}
            title={shownTitle(p.title)}
            model={p.model}
            coverUrl={p.coverUrl}
            takeCount={p.takePaths.length}
            share={{ visibility: p.visibility, takenDown: p.takenDown, onClick: () => openShare(p) }}
            featured={staff && isFeatured(p)}
            menuItems={sel.selecting ? undefined : menuFor(p)}
            selecting={sel.selecting}
            selected={sel.selected.has(p.id)}
            onSelect={sel.toggle}
            onOpen={open}
            byline={
              <>
                <span>Updated {ago(p.updatedAt)}</span>
                {p.busy && (
                  <Busy>
                    <Spin size="small" />
                    Working…
                  </Busy>
                )}
              </>
            }
          />
        ))}
      </CardListWrapper>
    );
  };

  return (
    <div className="my-experiments-page">
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
        <div className="home-toolbar">
          <SortMenu value={sort} onChange={setSort} options={PROJECT_SORT_OPTIONS} />
          <ScrollRow ariaLabel="Filter experiments">
            {chips.length > 0 && <ChipMultiFilter chips={chips} selected={filters} onChange={setFilters} />}
          </ScrollRow>
          <ListSearch value={term} onChange={setTerm} placeholder="Search experiments…" />
          <div className="list-toolbar-actions">
            <SelectButton onClick={sel.start} disabled={visible.length === 0} />
            {/* the one filled button in the band: the page's primary action, as it was before the band */}
            <Button type="primary" icon={<Plus size={16} />} loading={creating} onClick={create}>
              New Experiment
            </Button>
          </div>
        </div>
      )}
      {renderBody()}
      <BackToTop />
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
    </div>
  );
};

export default ProjectsPage;
