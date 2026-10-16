/*
 * Small wordings the AI Project pages share: times, a tool call's
 * arguments, and which account sees what a failed call answered.
 */

import type { ProjectImage } from './core/types';

/** The caption with the drawing's version in front when it was redrawn. */
export const pictureCaption = (image: ProjectImage): string =>
  (image.version ?? 1) > 1 ? `Version ${image.version} · ${image.caption}` : image.caption;

/** The project's captures in the Captures tab's order (newest first); as the app's CapturesTab has it. */
export function capturesInOrder<T extends { at: number }>(takes: T[]): T[] {
  return [...takes].sort((a, b) => b.at - a.at);
}

/** "1 project" / "3 projects". */
export const countProjects = (n: number): string => `${n} ${n === 1 ? 'project' : 'projects'}`;

/** How long ago, short, as the app's project list says it. */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)} h ago`;
  }
  return new Date(ms).toLocaleDateString();
}

/** When something was written, in full. */
export const writtenWhen = (ms: number): string => new Date(ms).toLocaleString();

/** A tool call's arguments, or nothing when they do not parse. */
export function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The one account that sees what a failed call answered (the app's user decision ㊿, 2026-10-15). */
const FAILED_CALL_DETAIL_ACCOUNT = 'xiaotong@intofuture.org';

export const showsFailedCalls = (email: string | null | undefined): boolean =>
  (email ?? '').trim().toLowerCase() === FAILED_CALL_DETAIL_ACCOUNT;

/** The app's own scheme for the website's "Open in App" button (the app registers the https path too). */
export function appProjectUrl(projectId: string, token: string | null): string {
  const base = `infraredexplorer://projects/${encodeURIComponent(projectId)}`;
  return token ? `${base}?k=${encodeURIComponent(token)}` : base;
}
