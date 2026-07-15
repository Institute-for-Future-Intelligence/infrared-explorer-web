import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar as AntAvatar, Button, Empty, Form, Input, Modal, Result, Spin, message } from 'antd';
import type { MenuProps } from 'antd';
import { EditOutlined, ExperimentOutlined, LinkOutlined, PushpinFilled, StarFilled } from '@ant-design/icons';
import { collection, getDocs, query, where } from 'firebase/firestore';
import dayjs from 'dayjs';
import styled from 'styled-components';
import { firebaseDatabase } from '../services/firebase';
import { getPublicProfile, updateProfilePins, updateUserProfile, PublicProfile } from '../services/account';
import { getPublicProfileStats, PublicProfileStats } from '../services/stats';
import useCommonStore from '../stores/common';
import { ExperimentDoc, ExperimentSubjects, Visibility } from '../types';
import ExperimentGrid, { GridItem } from '../components/card/experimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import { buildVisibilityMenuItem, changeVisibility } from '../components/visibilityControl';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import ShareLinks from './experimentAnalyzer/infoSection/shareLinks';
import BackToTop from '../components/backToTop';
import { HOME_URL } from '../utils/constants';

/*
 * Public user profile at /users/:userId (userId = mongoId, the same id usersPublic docs are
 * keyed by). Anyone — signed out included — sees the same thing: the identity header, the owner's
 * PUBLIC experiments (pinned ones first), and nothing private. This is a showcase, not a
 * management console — so the owner sees the exact visitor gallery (a true "view as others" preview)
 * plus three owner-only affordances: edit their identity, pin/unpin up to three experiments, and a
 * signpost to the workspace (My Experiments) where visibility / rename / trash live. A note reports
 * how many link-only / private clips exist without ever listing them here.
 */

const MAX_PINS = 3;

type ExperimentCard = ExperimentDoc & { id: string };

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// A profile is a gallery of finished, all-public work, so "Recently updated" and "By visibility"
// are both noise here (like Home).
const PROFILE_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'updated' && o.key !== 'visibility').map((o) =>
  o.key === 'newest' ? { ...o, label: 'Newest' } : o,
);

// Iron-colormap band, echoing the thermal palette of the recordings the page showcases.
const Banner = styled.div`
  height: 76px;
  border-radius: 10px;
  background: linear-gradient(105deg, #23103f, #6b2280 32%, #b23a3f 58%, #e0662a 78%, #f4a71f 96%);
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 20px;
  flex-wrap: wrap;
  padding: 0 20px;
  margin-top: -34px;
  margin-bottom: 8px;

  .profile-avatar {
    flex: none;
    border: 4px solid #fff;
    background: #6b2280;
    font-size: 34px;
  }
`;

const Info = styled.div`
  flex: 1;
  min-width: 240px;
  padding-top: 38px;

  h2 {
    margin: 0;
    font-size: 20px;
  }
  .bio {
    color: var(--ifi-text-secondary, #595959);
    margin: 4px 0 6px;
    max-width: 60em;
    white-space: pre-wrap;
  }
  .stat-line {
    color: var(--ifi-grey, #8c8c8c);
    font-size: 13px;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    b {
      color: var(--ifi-ink, #262626);
    }
  }
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 42px;
`;

const UserProfile = () => {
  const { userId } = useParams<{ userId: string }>();
  const user = useCommonStore((state) => state.user);
  const setUser = useCommonStore((state) => state.setUser);
  // Wait for the initial session restore before deciding visitor-vs-owner, so the owner doesn't
  // flash the visitor view (or a spurious 404) and then re-render once auth resolves.
  const authReady = useCommonStore((state) => state.authReady);
  const isSelf = !!user && user.id === userId;
  // 'system' owns the seeded showcases; it has no usersPublic doc and no profile to show.
  const isReserved = userId === 'system';

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [experiments, setExperiments] = useState<ExperimentCard[]>([]);
  const [expLoading, setExpLoading] = useState(true);
  // Ordered experiment ids the owner pinned to the top of the gallery (mirrors profile.pinned; kept
  // as its own state so pin/unpin updates optimistically without re-reading the profile doc).
  const [pins, setPins] = useState<string[]>([]);
  // Server-computed stats (authored-comment count). null = unavailable → the stat is omitted;
  // the page never blocks on it.
  const [profileStats, setProfileStats] = useState<PublicProfileStats | null>(null);

  // Visitor-grid controls (persisting them per profile would leak across users; keep transient).
  const [subject, setSubject] = useState<SubjectFilterValue>('all');
  const [sort, setSort] = useState<SortValue>('newest');

  // Edit-profile modal (owner only): display name + bio, saved to users/usersPublic.
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBio, setEditBio] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    if (!userId || userId === 'system') return;
    let cancelled = false;
    setProfileLoading(true);
    getPublicProfile(userId)
      .then((p) => {
        if (!cancelled) {
          setProfile(p);
          setPins(p?.pinned ?? []);
        }
      })
      .catch((e) => console.error('failed to load public profile', e))
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Authored-comment count via the getPublicProfileStats callable (visitors can't count another
  // user's comments under the rules). Fire-and-forget: failure just hides the stat.
  useEffect(() => {
    if (!userId || userId === 'system') return;
    let cancelled = false;
    setProfileStats(null); // clear the previous profile's count while this one loads
    getPublicProfileStats(userId).then((s) => {
      if (!cancelled) setProfileStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId || userId === 'system') return;
    let cancelled = false;
    setExpLoading(true);
    const fetchExperiments = async () => {
      try {
        const experimentsCol = collection(firebaseDatabase, 'experiments');
        // Rules are not filters: a visitor's list query must be provably constrained to
        // visibility == 'public' or it is denied outright. The owner loads everything and the
        // page groups it into the three visibility tabs client-side. Both queries are
        // equality-only (no orderBy), which needs no composite index AND keeps legacy docs
        // missing `createdAt` — an orderBy would silently drop those for visitors while the
        // owner's tab still showed them.
        const q = isSelf
          ? query(experimentsCol, where('ownerId', '==', userId), where('trash', '==', false))
          : query(
              experimentsCol,
              where('ownerId', '==', userId),
              where('visibility', '==', Visibility.Public),
              where('trash', '==', false),
            );
        const snap = await getDocs(q);
        const docs = snap.docs.map((d) => ({ ...(d.data() as ExperimentDoc), id: d.id }));
        // Newest-first client-side, tolerant of legacy docs missing createdAt.
        docs.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
        if (!cancelled) setExperiments(docs);
      } catch (e) {
        console.error('failed to load profile experiments', e);
        if (!cancelled) setExperiments([]);
      } finally {
        if (!cancelled) setExpLoading(false);
      }
    };
    fetchExperiments();
    return () => {
      cancelled = true;
    };
  }, [userId, isSelf]);

  // Visibility groups (owner view). Visitors only ever have public docs in `experiments`.
  const groups = useMemo(() => {
    const byTier: Record<Visibility, ExperimentCard[]> = {
      [Visibility.Public]: [],
      [Visibility.Unlisted]: [],
      [Visibility.Private]: [],
    };
    for (const e of experiments) byTier[e.visibility ?? Visibility.Unlisted].push(e);
    return byTier;
  }, [experiments]);
  const publicExperiments = groups[Visibility.Public];

  // Header stats are computed over the PUBLIC works only — the same numbers for everyone.
  // (Total views sums the Function-maintained viewCount, live since the recordView callable.)
  const ratingCount = publicExperiments.reduce((n, e) => n + (e.ratingCount ?? 0), 0);
  const ratingAvg = ratingCount ? publicExperiments.reduce((n, e) => n + (e.ratingSum ?? 0), 0) / ratingCount : 0;
  const totalViews = publicExperiments.reduce((n, e) => n + (e.viewCount ?? 0), 0);
  const joined = profile?.createdAt?.toDate ? dayjs(profile.createdAt.toDate()).format('MMM YYYY') : null;

  // Gallery grid: subject chips (only disciplines present) + sort, like the home page. Shown to
  // everyone — for the owner it IS the visitor view, so the profile is a true preview.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      publicExperiments.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [publicExperiments]);

  // Resolve the pinned ids to public experiments (in pin order); ids that no longer resolve to a
  // public owned experiment (unpinned elsewhere, since set private) simply drop out.
  const pinnedCards = useMemo(() => {
    const byId = new Map(publicExperiments.map((e) => [e.id, e]));
    return pins.map((id) => byId.get(id)).filter((e): e is ExperimentCard => !!e);
  }, [publicExperiments, pins]);
  const pinnedSet = useMemo(() => new Set(pinnedCards.map((e) => e.id)), [pinnedCards]);
  // The rest of the public gallery (everything not pinned), with the subject filter + sort applied.
  const galleryVisible = useMemo(
    () =>
      publicExperiments
        .filter((e) => !pinnedSet.has(e.id))
        .filter((s) => subject === 'all' || s.subject === subject)
        .sort(compareExperiments(sort)),
    [publicExperiments, pinnedSet, subject, sort],
  );

  if (!userId) return null;

  if (isReserved) {
    return (
      <Result
        status="404"
        title="User not found"
        subTitle="This profile does not exist."
        extra={<Link to="/">Back to home</Link>}
      />
    );
  }

  if (!authReady || profileLoading || expLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  // No public slice and nothing public to show: treat as an unknown user. (The owner always
  // sees their own page, even before ever saving a profile.)
  if (!isSelf && !profile && experiments.length === 0) {
    return (
      <Result
        status="404"
        title="User not found"
        subTitle="This profile does not exist or has nothing public."
        extra={<Link to="/">Back to home</Link>}
      />
    );
  }

  const name = profile?.displayName || (isSelf ? user?.displayName || user?.email : experiments[0]?.author) || 'User';
  const initial = name.trim().charAt(0).toUpperCase();
  const avatarSrc = profile?.avatar || (isSelf ? user?.avatar : undefined) || undefined;
  const profileUrl = `${HOME_URL}/#/users/${userId}`;

  const copyLink = () =>
    navigator.clipboard
      .writeText(profileUrl)
      .then(() => message.success('Profile link copied'))
      .catch(() => message.error('Failed to copy the link'));

  const openEdit = () => {
    setEditName(profile?.displayName ?? user?.displayName ?? '');
    setEditBio(profile?.bio ?? '');
    setEditOpen(true);
  };

  const saveProfile = async () => {
    if (!user || savingProfile) return;
    const displayName = editName.trim();
    if (!displayName) {
      message.error('Display name cannot be empty');
      return;
    }
    setSavingProfile(true);
    try {
      const bio = editBio.trim();
      await updateUserProfile(user.id, { displayName, bio });
      setProfile((p) => ({ ...(p ?? {}), displayName, bio }));
      setUser({ ...user, displayName });
      setEditOpen(false);
      message.success('Profile updated');
    } catch (e) {
      console.error('failed to save profile', e);
      message.error('Failed to save profile');
    } finally {
      setSavingProfile(false);
    }
  };

  // Feature / unfeature an experiment on the owner's profile (max MAX_PINS). "Featured" is the
  // showcase counterpart to the staff "Feature on homepage" — same idea, a different surface (your
  // profile vs the site homepage). Stored as `pinned` under the hood. Optimistic: patch local state
  // first for an instant reorder, then persist; roll back on failure.
  const togglePin = async (id: string, pin: boolean) => {
    if (!userId) return;
    if (pin && pins.length >= MAX_PINS) {
      message.info(`You can feature up to ${MAX_PINS} experiments on your profile`);
      return;
    }
    const previous = pins;
    const next = pin ? [...pins, id] : pins.filter((x) => x !== id);
    setPins(next);
    try {
      await updateProfilePins(userId, next);
      setProfile((p) => ({ ...(p ?? {}), pinned: next }));
      message.success(pin ? 'Featured on your profile' : 'Removed from your profile');
    } catch (e) {
      console.error('failed to update featured', e);
      setPins(previous);
      message.error('Failed to update your featured experiments');
    }
  };

  // Change a card's visibility from the profile. Patches the local list so a clip demoted below
  // Public drops out of the (public-only) gallery immediately; re-deriving groups handles the rest.
  const setItemVisibility = async (id: string, visibility: Visibility) => {
    if (await changeVisibility(id, visibility)) {
      setExperiments((prev) => prev.map((it) => (it.id === id ? { ...it, visibility } : it)));
    }
  };

  // Owner-only card menu on the profile: feature/unfeature + change visibility + open. (Rename /
  // trash still live only in the workspace, My Experiments.)
  const buildPinMenu = (item: GridItem): MenuProps['items'] => {
    const pinned = pinnedSet.has(item.id);
    return [
      {
        key: 'pin',
        label: pinned ? 'Remove from featured' : 'Add to featured',
        onClick: () => togglePin(item.id, !pinned),
      },
      {
        key: 'open',
        label: 'Open in new tab',
        onClick: () => window.open(`${window.location.origin}/#/experiments/${item.id}`, '_blank'),
      },
      // Rows always carry visibility here (loaded from ExperimentDoc); guard just in case.
      // Strip the leading icon so this menu stays text-only.
      ...(item.visibility
        ? [
            { type: 'divider' } as const,
            { ...buildVisibilityMenuItem(item.visibility, (v) => setItemVisibility(item.id, v)), icon: undefined },
          ]
        : []),
    ];
  };

  // The shared gallery both audiences see (owner === visitor preview): pinned first, then the rest.
  // The owner additionally gets the pin menu on each card.
  // Public experiments the owner hasn't pinned — the "Public experiments" shelf's contents before
  // the subject filter. Drives whether that shelf shows its grid (with toolbar) or an empty prompt.
  const nonPinnedCount = publicExperiments.length - pinnedCards.length;
  const gallery =
    // Visitors with nothing to show get a single centered empty state; owners always get the two
    // reserved shelves below (each with its own prompt) so the page layout stays consistent.
    publicExperiments.length === 0 && !isSelf ? (
      <Empty style={{ marginTop: 48 }} description="No public experiments yet." />
    ) : (
      <>
        {/* Owners always see the Featured shelf — even empty — so the slot reads as "pin your best
            work here". Visitors only see it once something is actually featured. */}
        {(pinnedCards.length > 0 || isSelf) && (
          <section className="profile-section">
            <h3 className="profile-section-title">
              <PushpinFilled /> Featured
            </h3>
            {pinnedCards.length > 0 ? (
              <ExperimentGrid items={pinnedCards} showAuthor={false} buildMenu={isSelf ? buildPinMenu : undefined} />
            ) : (
              <div className="profile-featured-empty">
                <p className="profile-featured-empty__text">
                  {publicExperiments.length === 0 ? (
                    'Spotlight your best experiments here once you have some public ones.'
                  ) : (
                    <>
                      Spotlight your best experiments here. Open the <b>⋯</b> menu on any card below and choose{' '}
                      <b>Add to featured</b>.
                    </>
                  )}
                </p>
              </div>
            )}
          </section>
        )}
        {/* Public experiments shelf — same reserved treatment as Featured for owners. */}
        {(nonPinnedCount > 0 || isSelf) && (
          <>
            {(pinnedCards.length > 0 || isSelf) && (
              <h3 className="profile-section-title profile-section-title--spaced">Public experiments</h3>
            )}
            {nonPinnedCount > 0 ? (
              <>
                <div className="home-toolbar">
                  <SortMenu value={sort} onChange={setSort} options={PROFILE_SORT_OPTIONS} />
                  {availableSubjects.length > 0 && (
                    <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
                  )}
                </div>
                <ExperimentGrid
                  items={galleryVisible}
                  showAuthor={false}
                  buildMenu={isSelf ? buildPinMenu : undefined}
                />
              </>
            ) : (
              <div className="profile-featured-empty">
                <p className="profile-featured-empty__text">
                  {publicExperiments.length === 0
                    ? 'Nothing public yet — set an experiment to Public to show it on your profile.'
                    : 'Every public experiment is featured above.'}
                </p>
                {publicExperiments.length === 0 && (
                  <Link to="/myExperimentsList">
                    <Button type="primary" icon={<ExperimentOutlined />}>
                      Manage in My Experiments
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </>
    );

  return (
    <div className="user-profile-page">
      <Banner />
      <HeaderRow>
        <AntAvatar className="profile-avatar" size={88} src={avatarSrc}>
          {initial}
        </AntAvatar>
        <Info>
          <h2>
            {name}
            {isSelf && (
              <span style={{ fontSize: 12, color: 'var(--ifi-grey, #8c8c8c)', fontWeight: 400, marginLeft: 8 }}>
                (this is you)
              </span>
            )}
          </h2>
          {profile?.bio && <p className="bio">{profile.bio}</p>}
          <div className="stat-line">
            <span>
              <b>{publicExperiments.length}</b> public experiment{publicExperiments.length === 1 ? '' : 's'}
            </span>
            {totalViews > 0 && (
              <span>
                <b>{totalViews}</b> view{totalViews === 1 ? '' : 's'}
              </span>
            )}
            {ratingCount > 0 && (
              <span>
                <StarFilled style={{ color: '#fadb14' }} /> <b>{ratingAvg.toFixed(1)}</b> ({ratingCount} rating
                {ratingCount === 1 ? '' : 's'})
              </span>
            )}
            {profileStats !== null && profileStats.comments > 0 && (
              <span>
                <b>{profileStats.comments}</b> comment{profileStats.comments === 1 ? '' : 's'}
              </span>
            )}
            {joined && <span>Joined {joined}</span>}
          </div>
        </Info>
        <Actions>
          {isSelf && (
            <Button icon={<EditOutlined />} onClick={openEdit}>
              Edit profile
            </Button>
          )}
          <Button icon={<LinkOutlined />} onClick={copyLink}>
            Copy link
          </Button>
          <ShareLinks title={`${name} on Infrared Explorer`} />
        </Actions>
      </HeaderRow>

      {gallery}

      <Modal
        title="Edit profile"
        open={editOpen}
        onOk={saveProfile}
        onCancel={() => setEditOpen(false)}
        okText="Save"
        confirmLoading={savingProfile}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="Display name" htmlFor="profile-display-name">
            <Input
              id="profile-display-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </Form.Item>
          <Form.Item label="Bio" htmlFor="profile-bio" extra="Shown on your public profile.">
            <Input.TextArea
              id="profile-bio"
              value={editBio}
              onChange={(e) => setEditBio(e.target.value)}
              maxLength={300}
              showCount
              rows={3}
              placeholder="Tell visitors what you explore with your thermal camera…"
            />
          </Form.Item>
        </Form>
      </Modal>

      <BackToTop />
    </div>
  );
};

export default UserProfile;
