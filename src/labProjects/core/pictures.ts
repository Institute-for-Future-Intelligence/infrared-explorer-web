/*
 * Which project pictures to show where: the newest version of each drawing,
 * the plan's pictures where the plan puts them, and the order the full-screen
 * viewer pages through in each tab (what that tab shows, top to bottom).
 * Pure; tested in __tests__/labProjectsPictures.test.ts.
 */

import {markdownImageIds} from './markdown';
import {discussRows, replyParts, replyProducts, replyWritesReport, stepPictureIds} from './replies';
import type {ProjectImage, Turn} from './types';

const lineageOf = (i: ProjectImage): string => i.lineage ?? i.id;

/** A drawing's versions, oldest first (just the picture itself for anything else). */
function versionsOf(img: ProjectImage, images: ProjectImage[]): ProjectImage[] {
  if (img.kind !== 'diagram') {
    return [img];
  }
  const lineage = lineageOf(img);
  return images
    .filter(i => i.kind === 'diagram' && lineageOf(i) === lineage)
    .sort((a, b) => (a.version ?? 1) - (b.version ?? 1) || a.at - b.at);
}

/** Newest version of each drawing, newest first. */
export function latestPictures(images: ProjectImage[]): ProjectImage[] {
  const byLineage = new Map<string, ProjectImage>();
  for (const i of images) {
    if (i.kind !== 'diagram') {
      continue;
    }
    const cur = byLineage.get(lineageOf(i));
    if (!cur || (i.version ?? 1) > (cur.version ?? 1)) {
      byLineage.set(lineageOf(i), i);
    }
  }
  return [...byLineage.values()].sort((a, b) => b.at - a.at);
}

/**
 * The plan (or any text) with each drawing it shows swapped for that
 * drawing's newest version, so a redrawn setup shows up in the plan without
 * the plan being rewritten.
 */
export function withNewestPictures(markdown: string, images: ProjectImage[]): string {
  const byId = new Map(images.map(i => [i.id, i]));
  return markdown.replace(/(!\[[^\]]*\]\()image:([^)\s]+)\)/g, (whole, head: string, id: string) => {
    const img = byId.get(id);
    if (!img) {
      return whole;
    }
    const versions = versionsOf(img, images);
    return `${head}image:${versions[versions.length - 1].id})`;
  });
}

/** The newest drawings a plan does not show, newest first (listed after it). */
export function picturesBesidePlan(markdown: string | null, images: ProjectImage[]): ProjectImage[] {
  const byId = new Map(images.map(i => [i.id, i]));
  const shown = new Set(
    markdownImageIds(markdown ?? '')
      .map(id => byId.get(id))
      .filter((i): i is ProjectImage => i != null)
      .map(lineageOf),
  );
  return latestPictures(images).filter(i => !shown.has(lineageOf(i)));
}

function collector(images: ProjectImage[]) {
  const byId = new Map(images.map(i => [i.id, i]));
  const seen = new Set<string>();
  const list: ProjectImage[] = [];
  const add = (img: ProjectImage | undefined) => {
    if (img && !seen.has(img.id)) {
      seen.add(img.id);
      list.push(img);
    }
  };
  return {list, add, addId: (id: string) => add(byId.get(id)), byId};
}

/**
 * The Plan tab, in order: the plan's pictures where it shows them, then the
 * other drawings — each drawing with its earlier versions just before it, so
 * a swipe back shows what it looked like before.
 */
export function planPictureSequence(markdown: string | null, images: ProjectImage[]): ProjectImage[] {
  const c = collector(images);
  for (const id of markdownImageIds(markdown ?? '')) {
    const img = c.byId.get(id);
    if (img) {
      versionsOf(img, images).forEach(c.add);
    }
  }
  for (const img of picturesBesidePlan(markdown, images)) {
    versionsOf(img, images).forEach(c.add);
  }
  return c.list;
}

/**
 * Every picture Discuss shows, in the order it shows them (replies.ts): in
 * each reply the steps' pictures (what the AI said, the frames it looked at),
 * then what the steps made, then the answer's own. Captures the user added
 * show as their gallery tiles, not as pictures; the overview sheets the app
 * made of them are the AI's. `live`: the last reply is still being made.
 */
export function discussPictureSequence(turns: Turn[], images: ProjectImage[], live = false): ProjectImage[] {
  const c = collector(images);
  const results = new Map<string, Turn>();
  for (const t of turns) {
    if (t.role === 'tool' && t.callId) {
      results.set(t.callId, t);
    }
  }
  const rows = discussRows(turns);
  rows.forEach((row, i) => {
    if (row.kind !== 'reply') {
      return;
    }
    const {steps, answer} = replyParts(row.turns, live && i === rows.length - 1);
    const forReport = replyWritesReport(row.turns, row.askedForReport);
    for (const t of steps) {
      markdownImageIds(t.text ?? '').forEach(c.addId);
      for (const call of t.toolCalls ?? []) {
        stepPictureIds(call, results.get(call.id), forReport).forEach(c.addId);
      }
    }
    for (const p of replyProducts(steps, results, images, answer, row.askedForReport)) {
      if (p.kind === 'picture') {
        c.add(p.image);
      }
    }
    if (answer) {
      markdownImageIds(answer.text ?? '').forEach(c.addId);
      // a reply that writes the report draws its answer's calls as steps: lines, no pictures
      for (const call of forReport ? [] : answer.toolCalls ?? []) {
        const ids = results.get(call.id)?.result?.imageIds ?? [];
        if (call.name === 'draw' || call.name === 'chart') {
          ids.slice(0, 1).forEach(c.addId);
        } else if (call.name === 'look' || call.name === 'run_code') {
          ids.forEach(c.addId);
        }
      }
    }
  });
  return c.list;
}

/** The pictures a text (the report) shows, in its order. */
export function markdownPictureSequence(markdown: string | null, images: ProjectImage[]): ProjectImage[] {
  const c = collector(images);
  markdownImageIds(markdown ?? '').forEach(c.addId);
  return c.list;
}
