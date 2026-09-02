import { useState } from 'react';
import { Button } from 'antd';
import { useIsPhone } from '../hooks/useIsMobile';
import { PRIVACY_URL } from '../utils/urls';

const COOKIE_KEY = 'ie-accept-cookie';

/**
 * First-visit storage notice; the acknowledgement is remembered in localStorage.
 *
 * Worded as "browser storage", not "cookies": the site sets no cookies of its own and runs no
 * analytics or advertising (firebase.ts never initialises Analytics) — what it does keep is the
 * Firebase sign-in session (IndexedDB) and display preferences (localStorage). The old
 * "uses cookies" line claimed a practice the code does not have, and the store privacy
 * disclosures now say the opposite; the banner has to agree with them.
 */
const AcceptCookie = () => {
  const isPhone = useIsPhone();
  const [accepted, setAccepted] = useState(() => localStorage.getItem(COOKIE_KEY) === 'true');

  if (accepted) return null;

  const accept = () => {
    localStorage.setItem(COOKIE_KEY, 'true');
    setAccepted(true);
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        display: 'flex',
        // On a phone, stack the message above a full-width button instead of wrapping inline.
        flexDirection: isPhone ? 'column' : 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: '12px 16px',
        background: '#2b373b',
        color: '#f5f5f5',
        fontSize: 13,
      }}
    >
      <span>
        This site stores your sign-in session and display preferences in your browser. No advertising or tracking
        cookies.{' '}
        <a href={PRIVACY_URL} style={{ color: '#9be3dc' }} target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </a>
      </span>
      <Button type="primary" size="small" onClick={accept} style={isPhone ? { width: '100%' } : undefined}>
        I understand
      </Button>
    </div>
  );
};

export default AcceptCookie;
