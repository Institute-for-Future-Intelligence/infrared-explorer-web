/*
 * How a project page words what the account has left of its AI turns
 * (docs/proposals/ai-access-tiers-and-anonymous-sign-in.md §10.4c). The
 * numbers are the server's alone (labProjectTurn's `quota`, labProjectQuota):
 * nothing here knows a limit. Staff have none, and the server says so with
 * null.
 *
 * Shown twice over: once as a bar above the message box, until the user
 * closes it (kept closed per account), and after that whenever asked, from
 * the page's corner menu.
 */

import {say, type QuotaLeft, type Wording} from './types';

/** The words, by the app's i18n key (Wording in types.ts). */
export const QUOTA_EN = {
  lab_quota_today_one: 'Today: {left} of {limit} AI turn left.',
  lab_quota_today_other: 'Today: {left} of {limit} AI turns left.',
  lab_quota_banner_anonymous: '{line} Sign in with Google or Apple for more.',
  lab_quota_unavailable: 'Could not load your AI usage. Check the connection and try again.',
  lab_quota_staff: 'Staff accounts have no limit on AI turns.',
  lab_quota_this_hour: 'This hour: {left} of {limit} left.',
  lab_quota_what_counts: 'Each message you send, each set of captures and each report request counts as one turn.',
  lab_quota_link_for_more:
    'Sign in with Google or Apple for more AI turns each day. Linking an account keeps your experiments.',
} as const;

export type QuotaKey = keyof typeof QUOTA_EN;

const today = (quota: QuotaLeft, tr?: Wording<QuotaKey>): string =>
  say(QUOTA_EN, quota.dayLimit === 1 ? 'lab_quota_today_one' : 'lab_quota_today_other', tr, {
    left: quota.dayLeft,
    limit: quota.dayLimit,
  });

/** The bar above the message box. */
export function quotaBannerText(quota: QuotaLeft, anonymous: boolean, tr?: Wording<QuotaKey>): string {
  const line = today(quota, tr);
  return anonymous ? say(QUOTA_EN, 'lab_quota_banner_anonymous', tr, {line}) : line;
}

/** The corner menu's AI Usage dialog; null quota = staff, undefined = the server could not be asked. */
export function quotaDialogMessage(
  quota: QuotaLeft | null | undefined,
  anonymous: boolean,
  tr?: Wording<QuotaKey>,
): string {
  if (quota === undefined) {
    return say(QUOTA_EN, 'lab_quota_unavailable', tr);
  }
  if (quota === null) {
    return say(QUOTA_EN, 'lab_quota_staff', tr);
  }
  const lines = [
    today(quota, tr),
    say(QUOTA_EN, 'lab_quota_this_hour', tr, {left: quota.hourLeft, limit: quota.hourLimit}),
    say(QUOTA_EN, 'lab_quota_what_counts', tr),
  ];
  if (anonymous) {
    lines.push(say(QUOTA_EN, 'lab_quota_link_for_more', tr));
  }
  return lines.join('\n\n');
}
