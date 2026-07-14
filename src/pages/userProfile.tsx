import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Avatar as AntAvatar, Button, Empty, Form, Input, Modal, Result, Spin, Tabs, message } from 'antd';
import type { TabsProps } from 'antd';
import { EditOutlined, LinkOutlined, StarFilled } from '@ant-design/icons';
import { collection, getDocs, query, where } from 'firebase/firestore';
import dayjs from 'dayjs';
import styled from 'styled-components';
import { firebaseDatabase } from '../services/firebase';
import { getPublicProfile, updateUserProfile, PublicProfile } from '../services/account';
import { getPublicProfileStats, PublicProfileStats } from '../services/stats';
import useCommonStore from '../stores/common';
import { ExperimentDoc, ExperimentSubjects, Visibility } from '../types';
import ExperimentGrid from '../components/card/experimentGrid';
import OwnedExperimentGrid from '../components/card/ownedExperimentGrid';
import { SUBJECT_META } from '../components/card/subjectMeta';
import SubjectFilter, { SubjectFilterValue } from '../components/subjectFilter';
import SortMenu, { SORT_OPTIONS, SortValue, compareExperiments } from '../components/sortMenu';
import { VISIBILITY_OPTIONS } from '../components/visibilityControl';
import ShareLinks from './experimentAnalyzer/infoSection/shareLinks';
import BackToTop from '../components/backToTop';
import { HOME_URL } from '../utils/constants';

/*
 * Public user profile at /users/:userId (userId = mongoId, the same id usersPublic docs are
 * keyed by). Anyone — signed out included — sees the header (usersPublic slice) and the owner's
 * PUBLIC experiments. The owner additionally gets their experiments grouped into three
 * visibility tabs (Public / Link only / Private) and manages the tier from each card's ⋮ menu;
 * the Public tab shows exactly what a visitor sees, so there is no separate preview mode.
 */

type ExperimentCard = ExperimentDoc & { id: string };

// Subject chips render in this fixed order (matching the badge palette); only those present show.
const SUBJECT_ORDER: ExperimentSubjects[] = [
  ExperimentSubjects.Physics,
  ExperimentSubjects.Chemistry,
  ExperimentSubjects.Biology,
];

// A profile is a gallery of finished work, so (like Home) "Recently updated" is noise here.
const PROFILE_SORT_OPTIONS = SORT_OPTIONS.filter((o) => o.key !== 'updated').map((o) =>
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
        if (!cancelled) setProfile(p);
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

  // Visitor grid: subject chips (only disciplines present) + sort, like the home page.
  const availableSubjects = useMemo(() => {
    const present = new Set(
      publicExperiments.map((s) => s.subject).filter((s): s is ExperimentSubjects => !!s && !!SUBJECT_META[s]),
    );
    return SUBJECT_ORDER.filter((s) => present.has(s));
  }, [publicExperiments]);
  const visitorVisible = useMemo(
    () => publicExperiments.filter((s) => subject === 'all' || s.subject === subject).sort(compareExperiments(sort)),
    [publicExperiments, subject, sort],
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

  // Owner view: the three visibility tabs. Each tab reuses the owned grid (⋮ menu with
  // rename / open / Visibility / trash); changing a tier moves the card to its new tab.
  // With zero experiments anywhere there is no ⋮ menu to point at — say what to do instead.
  const tierEmptyHint: Record<Visibility, string> = {
    [Visibility.Public]:
      experiments.length > 0
        ? 'Nothing public yet — open a card’s ⋮ menu and set its Visibility to Public.'
        : 'No experiments yet — record one with the Infrared Explorer app and it will appear here.',
    [Visibility.Unlisted]: 'Nothing shared by link only.',
    [Visibility.Private]: 'No private experiments.',
  };
  const tabItems: TabsProps['items'] = VISIBILITY_OPTIONS.slice()
    .reverse() // Public first — it's what the profile is about
    .map((o) => ({
      key: o.value,
      label: (
        <span>
          {o.icon} {o.label} ({groups[o.value].length})
        </span>
      ),
      children: groups[o.value].length ? (
        <OwnedExperimentGrid items={groups[o.value]} setItems={setExperiments} />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={tierEmptyHint[o.value]} />
      ),
    }));

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

      {isSelf ? (
        <Tabs items={tabItems} />
      ) : publicExperiments.length === 0 ? (
        <Empty style={{ marginTop: 48 }} description="No public experiments yet." />
      ) : (
        <>
          <div className="home-toolbar">
            <SortMenu value={sort} onChange={setSort} options={PROFILE_SORT_OPTIONS} />
            {availableSubjects.length > 0 && (
              <SubjectFilter value={subject} subjects={availableSubjects} onChange={setSubject} />
            )}
          </div>
          <ExperimentGrid items={visitorVisible} showAuthor={false} />
        </>
      )}

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
