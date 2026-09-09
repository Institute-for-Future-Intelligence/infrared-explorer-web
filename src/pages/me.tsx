import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar as AntAvatar, Button, Empty, Spin } from 'antd';
import { ProfileOutlined } from '@ant-design/icons';
import useCommonStore from '../stores/common';
import Card from '../components/card/card';
import type { GridItem } from '../components/card/experimentGrid';
import CardRowSection from '../components/hub/cardRowSection';
import ClassCard from '../components/classroom/ClassCard';
import { ClassInfo } from '../classroom/types';
import { fetchJoinedClasses, fetchTaughtClasses } from '../classroom/classroomApi';
import {
  isCaptureSource,
  useOwnedExperiments,
  useTrashedExperiments,
  useViewHistory,
} from '../hooks/useExperimentLists';
import { authorProfilePath } from '../utils/helpers';
import { userDisplayName } from '../utils/displayName';
import BackToTop from '../components/backToTop';

/*
 * "Me" (/me) — the signed-in user's private hub (YouTube-You-page-style): an identity strip, then
 * one horizontally scrolling row per personal collection (My Experiments / My Classes / History /
 * Raw Data / Trash), each capped at a preview slice with the full section one click away via the
 * row title or "View all". A launchpad, not a workspace: rows carry no management menus, no
 * filters, no search — those live on the section pages. The public profile (/users/:id) is
 * untouched by this page; the identity strip links to it, exactly as YouTube's You page links to
 * "View channel".
 */

// Preview slice per row. Data is already fetched in full by the shared hooks, so this is only a
// render cap: enough to fill any viewport width, small enough to keep the strips light.
const ROW_CAP = 12;

// Cards render nothing until their thumbnail resolves — and never resolve for a blank/failed
// thumbnailURL (history snapshots store '' when the source has none). Drop those up front so a row
// can't become a header over a permanently empty band.
const withThumbnail = <T extends GridItem>(items: T[]): T[] => items.filter((i) => !!i.thumbnailURL);

/** Experiment cards for one strip. History rows lack the aggregate counts; Card tolerates that. */
const StripCards = ({
  items,
  showVisibility,
  showAuthor,
}: {
  items: GridItem[];
  showVisibility?: boolean;
  showAuthor?: boolean;
}) => {
  const navigate = useNavigate();
  return (
    <>
      {items.slice(0, ROW_CAP).map((item) => {
        const authorHref = showAuthor ? authorProfilePath(item.ownerId, item.author) : undefined;
        return (
          <Card
            key={item.id}
            id={item.id}
            url={item.thumbnailURL}
            displayName={item.displayName}
            subject={item.subject}
            visibility={item.visibility}
            showVisibility={showVisibility}
            author={showAuthor ? item.author : undefined}
            description={item.description}
            ratingSum={item.ratingSum}
            ratingCount={item.ratingCount}
            viewCount={item.viewCount}
            commentCount={item.commentCount}
            createdAt={item.createdAt}
            updatedAt={item.updatedAt}
            duration={item.duration}
            sourceType={item.sourceType}
            photoCount={item.photoCount}
            onOpen={(id) => navigate(`/experiments/${id}`)}
            onAuthorClick={authorHref ? () => navigate(authorHref) : undefined}
          />
        );
      })}
    </>
  );
};

const Me = () => {
  const user = useCommonStore((state) => state.user);
  // Wait for the initial session restore before deciding signed-in vs out, so a signed-in user
  // hard-refreshing /me doesn't flash "Please sign in" during the async auth chain.
  const authReady = useCommonStore((state) => state.authReady);
  const navigate = useNavigate();

  const owned = useOwnedExperiments(user);
  const trashed = useTrashedExperiments(user);
  const history = useViewHistory(user, 24);

  // Raw captures are a subset of the owned (non-trashed) list, so derive the hub's Raw row from it
  // rather than issuing a second full scan of the same documents. (The Raw page keeps its own hook —
  // it's a standalone surface.) Mirrors useRawExperiments' filter.
  const rawItems = useMemo(
    () => owned.items.filter((e) => e.isRaw && isCaptureSource(e.sourceType) && !e.clonedFrom),
    [owned.items],
  );

  // Classes the user teaches or joined, shown as one strip (taught first). Settled independently
  // like the My Classes page, so one failing query can't blank the other list.
  const [classes, setClasses] = useState<{ info: ClassInfo; taught: boolean }[]>([]);
  useEffect(() => {
    if (!user) {
      setClasses([]);
      return;
    }
    let cancelled = false;
    setClasses([]); // clear the previous account's classes while this one loads
    Promise.allSettled([fetchTaughtClasses(user.id), fetchJoinedClasses(user.id)]).then(([t, j]) => {
      if (cancelled) return;
      const taught = t.status === 'fulfilled' ? t.value.map((info) => ({ info, taught: true })) : [];
      if (t.status === 'rejected') console.error('[me] failed to load taught classes', t.reason);
      const joined = j.status === 'fulfilled' ? j.value.map((info) => ({ info, taught: false })) : [];
      if (j.status === 'rejected') console.error('[me] failed to load joined classes', j.reason);
      setClasses([...taught, ...joined]);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!authReady) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 80 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (!user) return <div>Please sign in to see your page.</div>;

  // A derived name, never the raw address: see utils/displayName (Apple accounts arrive nameless).
  const name = userDisplayName(user);
  const initial = name.trim().charAt(0).toUpperCase();

  const ownedCards = withThumbnail(owned.items);
  const historyCards = withThumbnail(history.items);
  const trashedCards = withThumbnail(trashed.items);
  const rawCards = withThumbnail(rawItems);

  return (
    <div className="me-page">
      {/* Identity header — mirrors the public profile's banner + overlapping avatar so /me and the
          profile read as the same person's space. The strip is the private↔public bridge: who you
          are here, one click to what others see. */}
      <div className="hub-banner" />
      <div className="hub-identity">
        <Link to={`/users/${user.id}`} className="hub-identity-avatar-link" aria-label="View public profile">
          <AntAvatar className="hub-identity-avatar" size={88} src={user.avatar ?? undefined}>
            {initial}
          </AntAvatar>
        </Link>
        <div className="hub-identity-info">
          <h2>
            <Link to={`/users/${user.id}`} className="hub-identity-name-link">
              {name}
            </Link>
          </h2>
          {user.email && <div className="hub-identity-sub">{user.email}</div>}
        </div>
        <div className="hub-identity-actions">
          <Link to={`/users/${user.id}`}>
            <Button icon={<ProfileOutlined />}>View public profile</Button>
          </Link>
        </div>
      </div>

      {owned.loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
          <Spin size="large" />
        </div>
      ) : (
        <>
          {/* Always present — this is the primary row; an empty hub must say what to do next. The
              empty state renders as a full-width block (not a strip child) so it wraps normally. */}
          <CardRowSection
            title="My Experiments"
            to="/myExperimentsList"
            empty={
              ownedCards.length ? undefined : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No experiments yet — record one with the Infrared Explorer app and it will appear here."
                />
              )
            }
          >
            {ownedCards.length > 0 && <StripCards items={ownedCards} showVisibility />}
          </CardRowSection>

          {/* The remaining collections earn their row only when non-empty. */}
          {classes.length > 0 && (
            <CardRowSection title="My Classes" to="/classroom">
              {classes.slice(0, ROW_CAP).map(({ info, taught }) => (
                <div className="strip-class-card" key={info.id}>
                  <ClassCard
                    info={info}
                    taught={taught}
                    cardWidth="100%"
                    onOpen={() => navigate(`/classroom/${info.id}`)}
                  />
                </div>
              ))}
            </CardRowSection>
          )}

          {rawCards.length > 0 && (
            <CardRowSection title="Raw Data" to="/raw">
              <StripCards items={rawCards} showVisibility />
            </CardRowSection>
          )}

          {historyCards.length > 0 && (
            <CardRowSection title="History" to="/recent">
              <StripCards items={historyCards} showAuthor />
            </CardRowSection>
          )}

          {trashedCards.length > 0 && (
            <CardRowSection title="Trash" to="/trash">
              <StripCards items={trashedCards} />
            </CardRowSection>
          )}
        </>
      )}

      <BackToTop />
    </div>
  );
};

export default Me;
