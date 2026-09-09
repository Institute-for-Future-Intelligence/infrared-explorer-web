/*
 * Street View (/streetview) — a public map of geo-tagged thermal panoramas (the
 * viewer side of the app's Infrared Street View). The map (Google Maps, lazy-
 * loaded) plots every public `streetviews` doc as a ★; clicking one opens the
 * look-around viewer. Capture/upload stays in the mobile app. Neighbour jumps are
 * resolved against the already-loaded set (no extra fetch — the whole public set,
 * ~238 docs, loads up front). See docs/street-view-web-plan.md.
 *
 * This page is also where the map is moderated from, because there is no moderation
 * anywhere else: nothing is reviewed before it goes up, so what keeps the map honest is a
 * report from whoever is looking at it. Hence ?sv= as a first-class address (the notification
 * e-mails and the app's share link both point here), a Report anyone can reach signed out, and
 * — for the reader who simply wants someone gone — a per-viewer block list that is filtered
 * here rather than in the query. See docs/proposals/street-view-ugc-governance.md in the app
 * repo.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Popover, Segmented, Spin, Switch, message } from 'antd';
import EmptyState from '../../components/emptyState';
import ModerationNotePrompt from '../../components/moderationNotePrompt';
import { useStreetViews } from '../../hooks/useStreetViews';
import { usePersistentState } from '../../hooks/usePersistentState';
import useCommonStore from '../../stores/common';
import { isStaff } from '../../utils/staff';
import {
  BlockedAuthor,
  blockAuthor,
  fetchStreetView,
  listBlockedAuthors,
  reviewStreetView,
  unblockAuthor,
} from '../../services/streetViewModeration';
import StreetViewViewer from './streetViewViewer';
import ReportStreetViewModal, { ReportTarget } from './reportStreetViewModal';
import type { ReportResult } from '../../services/streetViewModeration';
import type { StreetView as StreetViewType } from '../../types';

const StreetViewMap = lazy(() => import('./streetViewMap'));
const MAPS_API_KEY = import.meta.env.VITE_MAPS_API_KEY as string | undefined;

const MAP_TYPE_OPTIONS = [
  { label: 'Map', value: 'roadmap' },
  { label: 'Satellite', value: 'satellite' },
  { label: 'Hybrid', value: 'hybrid' },
];

const TAKEDOWN_REASONS = ['Inappropriate content', 'Privacy concern', 'Spam or not a street view', 'Other'];

export default function StreetView() {
  const user = useCommonStore((state) => state.user);
  const staff = isStaff(user);
  const { items, loading, error, retry } = useStreetViews(true);
  const [mapType, setMapType] = usePersistentState<string>('streetview.mapType', 'roadmap');
  // Map labels off by default: Google's POI/place clutter buries our ★ markers, and
  // they're the only payload. "Off" still keeps street names for orientation. Satellite
  // has no labels, so the switch is moot there (disabled; the preference is kept).
  const [showLabels, setShowLabels] = usePersistentState<boolean>('streetview.labels', false);
  const labelsMoot = mapType === 'satellite';
  const [selected, setSelected] = useState<StreetViewType | null>(null);
  const [entryAzimuth, setEntryAzimuth] = useState<number | undefined>(undefined);
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkId = searchParams.get('sv');

  // Authors this account has hidden, and panoramas this browser has reported. The first is the
  // account's list (the app writes it too); the second is local because a guest has no account
  // to hang it on — but a report has to stop showing the reporter the thing they reported, and
  // it has to still be gone after a refresh, so it lives in localStorage either way.
  const [blocked, setBlocked] = useState<BlockedAuthor[]>([]);
  const [hiddenIds, setHiddenIds] = usePersistentState<string[]>('streetview.reported', []);
  const blockedIds = useMemo(() => new Set(blocked.map((b) => b.authorId)), [blocked]);

  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [takedownFor, setTakedownFor] = useState<StreetViewType | null>(null);
  const [takingDown, setTakingDown] = useState(false);

  useEffect(() => {
    if (!user) {
      setBlocked([]);
      return;
    }
    let cancelled = false;
    listBlockedAuthors(user.id)
      .then((rows) => {
        if (!cancelled) setBlocked(rows);
      })
      .catch((e) => console.warn('failed to load hidden authors', e));
    return () => {
      cancelled = true;
    };
  }, [user]);

  // What the map draws. Your own panoramas are never filtered out by your own block list —
  // blocking yourself is not a thing anyone means to do, and a map missing your own work reads
  // as data loss.
  const visible = useMemo(
    () =>
      items.filter(
        (i) => !hiddenIds.includes(i.svId) && (i.ownerId === user?.id || !i.ownerId || !blockedIds.has(i.ownerId)),
      ),
    [items, hiddenIds, blockedIds, user],
  );
  const visibleIds = useMemo(() => new Set(visible.map((i) => i.svId)), [visible]);

  const setDeepLink = useCallback(
    (svId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (svId) next.set('sv', svId);
          else next.delete('sv');
          return next;
        },
        // Replace rather than push: the viewer is a layer over the map, and a Back button that
        // walked through every panorama looked at would never reach the page before this one.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const openMarker = useCallback(
    (sv: StreetViewType) => {
      setEntryAzimuth(undefined);
      setSelected(sv);
      setDeepLink(sv.svId);
    },
    [setDeepLink],
  );

  const closeViewer = useCallback(() => {
    setSelected(null);
    setDeepLink(null);
  }, [setDeepLink]);

  // Neighbour jump: swap to the adjacent doc from the loaded set, facing the way we left.
  const openNeighbor = useCallback(
    (svId: string, fromAzimuth: number) => {
      const next = visible.find((i) => i.svId === svId);
      if (!next) {
        // Hidden, taken down, or by someone this reader has blocked — all the same from here.
        message.info('That street view is no longer available.');
        return;
      }
      setEntryAzimuth(Number.isFinite(fromAzimuth) ? fromAzimuth : undefined);
      setSelected(next);
      setDeepLink(next.svId);
    },
    [visible, setDeepLink],
  );

  // ?sv=<id> — from a notification e-mail, the admin queue, or the app's share link. Resolved
  // against the loaded set first; anything not in it (an owner's own hidden panorama, say) is
  // fetched directly, and the two ways of being unreachable — gone, or not yours to see — are
  // deliberately answered the same way, since the rules do not distinguish them either.
  useEffect(() => {
    if (!deepLinkId || loading) return;
    if (selected?.svId === deepLinkId) return;
    const local = items.find((i) => i.svId === deepLinkId);
    if (local) {
      setEntryAzimuth(undefined);
      setSelected(local);
      return;
    }
    let cancelled = false;
    fetchStreetView(deepLinkId).then((sv) => {
      if (cancelled) return;
      if (sv) {
        setEntryAzimuth(undefined);
        setSelected(sv);
      } else {
        message.info('This street view is no longer available.');
        setDeepLink(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [deepLinkId, loading, items, selected?.svId, setDeepLink]);

  // Neighbour pills point only at panoramas this reader can actually reach, so a blocked or
  // hidden one is not offered and then refused.
  const selectedForViewer = useMemo(() => {
    if (!selected) return null;
    const neighbors = selected.neighbors.filter((n) => visibleIds.has(n.svId));
    return neighbors.length === selected.neighbors.length ? selected : { ...selected, neighbors };
  }, [selected, visibleIds]);

  const openReport = useCallback(
    (kind: 'streetview' | 'author') => {
      if (!selected) return;
      setReportTarget(
        kind === 'author'
          ? { kind, authorId: selected.ownerId, label: selected.author || 'this author' }
          : { kind, svId: selected.svId, label: selected.title },
      );
    },
    [selected],
  );

  const onReported = useCallback(
    (result: ReportResult, target: ReportTarget) => {
      setReportTarget(null);
      if (result.duplicate) {
        message.info('You have already reported this — we are still looking at it.');
      } else {
        message.success(
          target.kind === 'author'
            ? 'Thank you. We will look at what this author has published.'
            : 'Thank you. We will look at this street view within 24 hours.',
        );
      }
      // Whoever reported a panorama stops seeing it here, whether or not the report moved
      // anything for everyone else. That is the whole of what a guest report does on its own.
      if (target.kind === 'streetview' && target.svId) {
        const id = target.svId;
        setHiddenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        closeViewer();
      }
    },
    [closeViewer, setHiddenIds],
  );

  const hideAuthor = useCallback(async () => {
    if (!user || !selected?.ownerId) return;
    const authorId = selected.ownerId;
    const name = selected.author || 'this author';
    try {
      await blockAuthor(user.id, authorId, name);
      setBlocked((prev) => [
        { authorId, authorName: name, createdAtMillis: Date.now() },
        ...prev.filter((b) => b.authorId !== authorId),
      ]);
      closeViewer();
      message.success(`Hidden. You will not see ${name}'s street views. Undo under "Hidden authors" on the map.`);
    } catch (e) {
      console.error('failed to hide author', e);
      message.error('Could not hide that author.');
    }
  }, [user, selected, closeViewer]);

  const unhideAuthor = useCallback(
    async (authorId: string) => {
      if (!user) return;
      try {
        await unblockAuthor(user.id, authorId);
        setBlocked((prev) => prev.filter((b) => b.authorId !== authorId));
      } catch (e) {
        console.error('failed to unhide author', e);
        message.error('Could not undo that.');
      }
    },
    [user],
  );

  const confirmTakedown = useCallback(
    async (note: string) => {
      const target = takedownFor;
      if (!target) return;
      setTakingDown(true);
      try {
        const res = await reviewStreetView(target.svId, 'remove', note);
        setTakedownFor(null);
        closeViewer();
        setHiddenIds((prev) => (prev.includes(target.svId) ? prev : [...prev, target.svId]));
        message.success(
          res.legacy
            ? 'Taken down. This one is from the seeded map, so its source files on intofuture.org still need removing by hand.'
            : 'Taken down. The author has been told and the pictures are gone.',
        );
      } catch (e) {
        console.error('takedown failed', e);
        message.error((e as { message?: string }).message || 'Could not take that down.');
      } finally {
        setTakingDown(false);
      }
    },
    [takedownFor, closeViewer, setHiddenIds],
  );

  if (!MAPS_API_KEY) {
    return (
      <div className="streetview-page">
        <EmptyState title="Map unavailable" hint="VITE_MAPS_API_KEY is not configured for this build." />
      </div>
    );
  }

  const hiddenAuthorsPanel = (
    <div style={{ maxWidth: 260 }}>
      {blocked.map((b) => (
        <div key={b.authorId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {b.authorName || b.authorId}
          </span>
          <Button type="link" size="small" onClick={() => unhideAuthor(b.authorId)}>
            Unhide
          </Button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="streetview-page">
      <div className="streetview-map-wrap">
        <Suspense
          fallback={
            <div className="streetview-map-loading">
              <Spin size="large" />
            </div>
          }
        >
          <StreetViewMap items={visible} mapType={mapType} showLabels={showLabels} onSelect={openMarker} />
        </Suspense>

        <div className="streetview-controls">
          <Segmented
            size="small"
            value={mapType}
            onChange={(v) => setMapType(v as string)}
            options={MAP_TYPE_OPTIONS}
          />
          <label
            className={`streetview-labels-toggle${labelsMoot ? ' is-moot' : ''}`}
            title={
              labelsMoot ? 'Satellite imagery has no labels' : 'Show place & business labels (street names always stay)'
            }
          >
            <Switch
              size="small"
              checked={showLabels}
              disabled={labelsMoot}
              onChange={(checked) => setShowLabels(checked)}
            />
            Labels
          </label>
          {/* Only here when there is something to undo — but then always here, so hiding
              someone is never a decision the reader cannot find again. */}
          {blocked.length > 0 && (
            <Popover content={hiddenAuthorsPanel} title="Hidden authors" trigger="click" placement="bottomRight">
              <Button type="text" size="small">
                Hidden authors ({blocked.length})
              </Button>
            </Popover>
          )}
        </div>

        <div
          className={`streetview-badge${error ? ' streetview-badge-error' : ''}`}
          onClick={error ? retry : undefined}
          role={error ? 'button' : undefined}
        >
          {error
            ? "Couldn't load — tap to retry"
            : loading
              ? 'Loading street views…'
              : `${visible.length} street view${visible.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {selectedForViewer && (
        <StreetViewViewer
          key={selectedForViewer.svId}
          sv={selectedForViewer}
          initialAzimuth={entryAzimuth}
          onClose={closeViewer}
          onNeighbor={openNeighbor}
          // Reporting your own panorama is refused server-side, so it is not offered here.
          onReport={selectedForViewer.ownerId && selectedForViewer.ownerId === user?.id ? undefined : openReport}
          // Hiding an author needs an account to hang the list on, and a real author to hide:
          // the seeded map is ours, and hiding yourself is not something anyone means to do.
          onBlockAuthor={
            user && selectedForViewer.ownerId && selectedForViewer.ownerId !== user.id ? hideAuthor : undefined
          }
          onTakeDown={staff ? () => setTakedownFor(selectedForViewer) : undefined}
        />
      )}

      <ReportStreetViewModal target={reportTarget} onCancel={() => setReportTarget(null)} onDone={onReported} />

      <ModerationNotePrompt
        open={!!takedownFor}
        busy={takingDown}
        title="Take down this street view?"
        okText="Take down"
        reasons={TAKEDOWN_REASONS}
        description={
          <p style={{ marginTop: 0 }}>
            <b>{takedownFor?.title}</b> comes off the map for everyone and its pictures are deleted. The author is told
            what happened and can appeal. Only a staff Restore brings it back.
          </p>
        }
        onCancel={() => setTakedownFor(null)}
        onConfirm={confirmTakedown}
      />
    </div>
  );
}
