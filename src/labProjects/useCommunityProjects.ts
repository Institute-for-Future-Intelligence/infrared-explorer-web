/*
 * The public AI projects, as Community lists them: the first page when the
 * caller first asks for it, more on loadMore, newest first. Read through
 * labProjectCommunityList (api.ts listCommunityProjects), which needs no
 * account and already leaves out the projects staff took down. The shape
 * of hooks/useCommunityExperiments.ts, without its client-side filter loop:
 * that one drops the 'system' seed showcases and blank thumbnails, neither
 * of which a project has.
 *
 * Governance beyond the server's: none here yet. The site's Community page
 * applies no per-viewer author filter to experiments (the Street View block
 * list under users/{mongoId}/blocks is Street View's own), so there is no
 * list to apply to a project's owner.id. TODO: Hide This Author / Report
 * Project for projects — the app repository's
 * docs/proposals/lab-project-sharing.md §9.4.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listCommunityProjects } from './api';
import type { CommunityProject, CommunityProjectCursor } from './core/types';

export interface CommunityProjectsState {
  items: CommunityProject[];
  /** The first page is in flight. */
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

export function useCommunityProjects(active: boolean): CommunityProjectsState {
  const [items, setItems] = useState<CommunityProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursorRef = useRef<CommunityProjectCursor | null>(null);
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);

  const fetchPage = useCallback(async (initial: boolean) => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    if (initial) {
      setLoading(true);
      setError(false);
    } else {
      setLoadingMore(true);
    }
    try {
      const page = await listCommunityProjects(cursorRef.current);
      cursorRef.current = page.cursor;
      setHasMore(page.hasMore && page.cursor != null);
      setItems((prev) => {
        if (initial) {
          return page.projects;
        }
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.projects.filter((p) => !seen.has(p.id))];
      });
    } catch (e) {
      console.error('failed to load community projects', e);
      setError(true);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (active && !startedRef.current) {
      startedRef.current = true;
      fetchPage(true);
    }
  }, [active, fetchPage]);

  const loadMore = useCallback(() => {
    if (!inFlightRef.current && hasMore) {
      fetchPage(false);
    }
  }, [fetchPage, hasMore]);

  const retry = useCallback(() => {
    cursorRef.current = null;
    setItems([]);
    setHasMore(true);
    startedRef.current = true;
    fetchPage(true);
  }, [fetchPage]);

  return { items, loading, loadingMore, error, hasMore, loadMore, retry };
}
