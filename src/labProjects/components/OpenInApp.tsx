/*
 * "Open in App" for a project someone else shared: the app's own scheme
 * (which launches it; the https link is a deep link too, but one opened in
 * a browser does not), and the store badges, shown as they are, for whoever
 * has no app yet. The old /projects/:id landing page's layout: `page` is that
 * page (button, "Don't have the app yet?", badges, centred); `bar` is the
 * same in one row, for the shared project's title.
 */

import type { ReactNode } from 'react';
import { Button } from 'antd';
import styled from 'styled-components';
import { APP_STORE_URL, PLAY_STORE_URL } from '../../utils/urls';
import googlePlayBadge from '../../assets/badge-google-play.svg';
import appStoreBadge from '../../assets/badge-app-store.svg';
import { appProjectUrl } from '../format';

// The stores' own badge artwork, unmodified, as both brand guidelines require; Apple's minimum on
// screen is 40px. The large button is 40px too, so a row of them lines up.
const STORE_BADGE_HEIGHT = 40;

const Block = styled.div<{ $page: boolean }>`
  display: flex;
  flex-direction: ${({ $page }) => ($page ? 'column' : 'row')};
  align-items: center;
  gap: ${({ $page }) => ($page ? '0' : '8px')};
  flex-wrap: wrap;

  .oia-actions,
  .oia-badges {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: ${({ $page }) => ($page ? '12px' : '8px')};
  }
  .oia-badges a {
    display: flex;
  }
  p {
    margin: 32px 0 12px;
    color: var(--ifi-text-secondary);
  }
`;

const OpenInApp = ({
  projectId,
  token,
  variant = 'bar',
  extra,
}: {
  projectId: string;
  token: string | null;
  variant?: 'page' | 'bar';
  // buttons put before "Open in App" (the error page's Sign In)
  extra?: ReactNode;
}) => {
  const page = variant === 'page';
  return (
    <Block $page={page}>
      <div className="oia-actions">
        {extra}
        <Button type="primary" size="large" href={appProjectUrl(projectId, token)}>
          Open in App
        </Button>
      </div>
      {page && <p>Don&apos;t have the app yet?</p>}
      <div className="oia-badges">
        <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer">
          <img src={googlePlayBadge} alt="Get it on Google Play" height={STORE_BADGE_HEIGHT} />
        </a>
        <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer">
          <img src={appStoreBadge} alt="Download on the App Store" height={STORE_BADGE_HEIGHT} />
        </a>
      </div>
    </Block>
  );
};

export default OpenInApp;
