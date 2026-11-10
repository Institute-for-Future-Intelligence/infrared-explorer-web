/*
 * Everything in a conversation that the Lightbox turns through from Discuss,
 * in the order Discuss shows it: the photos each of the user's messages
 * carried, and each reply's pictures (core/pictures.ts
 * discussPictureSequence — what the AI drew and what its code plotted; the
 * frames it looked at for itself stay out, user decision 2026-11-10). One row, as the app's viewer has it (its
 * lib/labProjects/discussViewer.ts; user decision, 2026-11-09): a photo the
 * user sent opens beside the AI's pictures, not in the analyzer.
 *
 * A capture's photo here is its cloud copy's cover (a photo's thumbnail is
 * its own picture, data_1.png). A recording has no place in the row — its
 * tile opens the analyzer — and neither has a photo without a copy in the
 * cloud, or one since removed from the project.
 *
 * Pure; tested in discussViewer.test.ts.
 */

import { discussPictureSequence } from './core/pictures';
import { discussRows } from './core/replies';
import type { ProjectImage, Take, Turn } from './core/types';
import type { LightboxPicture } from './components/Lightbox';
import type { CloudThumbState } from './useCloudThumbs';

/** The captures a turn carried, in the order Discuss draws their tiles. */
export function turnTakeIds(turn: Turn): string[] {
  const ids: string[] = [];
  for (const a of turn.attachments ?? []) {
    ids.push(a.takeId);
  }
  for (const k of turn.event?.takes ?? []) {
    ids.push(k.takeId);
  }
  return [...new Set(ids)];
}

/**
 * A capture as the Lightbox shows it: a photo with a cloud copy, under its
 * number and name. Null for anything else (a recording, a photo on the
 * owner's phone only, a removed capture).
 */
export function capturePhoto(
  take: Take | null | undefined,
  n: number | null | undefined,
  state: CloudThumbState | undefined,
): LightboxPicture | null {
  if (!take || take.source !== 'photos' || state?.kind !== 'ready' || !state.thumb.thumbnailUrl) {
    return null;
  }
  return {
    id: `take:${take.takeId}`,
    url: state.thumb.thumbnailUrl,
    caption: n != null ? `Capture ${n} · ${take.name}` : take.name,
  };
}

/**
 * `photoOf`: the capture's photo by take id (capturePhoto), null when it has
 * none to show. `live`: the last reply is still being made (as
 * discussPictureSequence).
 */
export function discussViewerSequence(
  turns: Turn[],
  images: ProjectImage[],
  live: boolean,
  photoOf: (takeId: string) => LightboxPicture | null,
): LightboxPicture[] {
  const out: LightboxPicture[] = [];
  const seen = new Set<string>();
  const add = (p: LightboxPicture | null) => {
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  };
  // a reply's calls are answered by tool turns, which are not rows
  const toolTurns = turns.filter((t) => t.role === 'tool');
  const rows = discussRows(turns);
  // the user's turn a reply answers: whether it asked for the report decides which pictures the reply shows
  let ask: Turn | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind === 'turn') {
      const t = row.turn;
      if (t.role === 'user' || t.role === 'event') {
        ask = t;
      }
      // tiles are drawn on the user's messages only (an older event turn is one grey line)
      if (t.role === 'user' && t.request !== 'report') {
        turnTakeIds(t).forEach((id) => add(photoOf(id)));
      }
      continue;
    }
    // this reply's pictures, in its own order: the reply alone, after the turn it answers
    const own = discussPictureSequence(
      [...(ask ? [ask] : []), ...row.turns, ...toolTurns],
      images,
      live && i === rows.length - 1,
    );
    own.forEach(add);
  }
  return out;
}
