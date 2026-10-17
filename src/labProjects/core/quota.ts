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

import type {QuotaLeft} from './types';

const turns = (n: number): string => `${n} AI ${n === 1 ? 'turn' : 'turns'}`;

/** The bar above the message box. */
export function quotaBannerText(quota: QuotaLeft, anonymous: boolean): string {
  const line = `Today: ${quota.dayLeft} of ${turns(quota.dayLimit)} left.`;
  return anonymous ? `${line} Sign in with Google or Apple for more.` : line;
}

/** The corner menu's AI Usage dialog; null quota = staff, undefined = the server could not be asked. */
export function quotaDialogMessage(quota: QuotaLeft | null | undefined, anonymous: boolean): string {
  if (quota === undefined) {
    return 'Could not load your AI usage. Check the connection and try again.';
  }
  if (quota === null) {
    return 'Staff accounts have no limit on AI turns.';
  }
  const lines = [
    `Today: ${quota.dayLeft} of ${turns(quota.dayLimit)} left.`,
    `This hour: ${quota.hourLeft} of ${quota.hourLimit} left.`,
    'Each message you send, each set of captures and each report request counts as one turn.',
  ];
  if (anonymous) {
    lines.push('Sign in with Google or Apple for more AI turns each day. Linking an account keeps your experiments.');
  }
  return lines.join('\n\n');
}
