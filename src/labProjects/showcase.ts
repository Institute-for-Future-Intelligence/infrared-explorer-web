/*
 * Staff's homepage showcase for experiments (labProjectFeature), as My
 * Recordings' Admin › Add to homepage showcase has it for recordings: offered
 * on the /projects cards' ⋮ and on a project page's ⋮. The owner's own views of
 * a project do not say whether it is featured, so the picks are read from the
 * showcase's list. The server features only a public project and drops the
 * pick once it leaves Public; adding one that is not Public sets it Public
 * first, as featuring a recording does.
 */

import { useEffect, useState } from 'react';
import { message } from 'antd';
import { ensureUgcConsent } from '../services/ugcConsent';
import { listFeaturedProjects, setProjectFeatured, shareProject } from './api';
import type { Project, ShareVisibility } from './core/types';
import { TAKEN_DOWN } from './shareTiers';

/** The ids of the featured experiments, read for staff only (empty for anyone else). */
export function useShowcaseIds(uid: string | null, staff: boolean) {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setIds(new Set());
    if (!uid || !staff) {
      return;
    }
    let live = true;
    listFeaturedProjects()
      .then((ps) => live && setIds(new Set(ps.map((p) => p.id))))
      .catch((e) => console.error('could not load the showcase', e));
    return () => {
      live = false;
    };
  }, [uid, staff]);
  const mark = (id: string, featured: boolean) =>
    setIds((prev) => {
      const next = new Set(prev);
      if (featured) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  return { ids, mark };
}

/** A pick counts only while the project is Public and not taken down (the server's own rule). */
export const shownFeatured = (ids: Set<string>, id: string, visibility: ShareVisibility, takenDown?: boolean) =>
  ids.has(id) && visibility === 'public' && !takenDown;

/**
 * Add the project to the showcase or take it out, with toast feedback. Resolves
 * whether it is now featured, and the project as it now is when adding it set
 * it Public (to patch the caller's copy); null when nothing changed.
 */
export async function changeProjectFeatured(
  p: { id: string; visibility: ShareVisibility; takenDown?: boolean },
  featured: boolean,
  userId: string,
): Promise<{ featured: boolean; shared?: Project } | null> {
  if (featured && p.takenDown) {
    message.info(TAKEN_DOWN);
    return null;
  }
  let shared: Project | undefined;
  try {
    if (featured && p.visibility !== 'public') {
      // the first switch out of Private passes the site's UGC terms record, as the Share panel does
      if (p.visibility === 'private') {
        await ensureUgcConsent(userId);
      }
      shared = await shareProject(p.id, 'public');
    }
    const c = await setProjectFeatured(p.id, featured);
    message.success(
      featured
        ? shared
          ? 'Added to the homepage showcase (set to Public)'
          : 'Added to the homepage showcase'
        : 'Removed from the homepage showcase',
    );
    return { featured: c.featured ?? featured, shared };
  } catch (e) {
    console.error('could not change the showcase', e);
    message.error((e as Error)?.message || 'Failed to update homepage feature');
    // set Public but not featured: the caller still takes the new tier
    return shared ? { featured: !featured, shared } : null;
  }
}
