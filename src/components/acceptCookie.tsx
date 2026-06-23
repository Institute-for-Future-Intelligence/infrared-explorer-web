import { useState } from 'react';
import { Button } from 'antd';

const COOKIE_KEY = 'ie-accept-cookie';

/** Lightweight cookie-consent banner; the choice is remembered in localStorage. */
const AcceptCookie = () => {
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
      <span>This website uses cookies to enhance the user experience.</span>
      <Button type="primary" size="small" onClick={accept}>
        I understand
      </Button>
    </div>
  );
};

export default AcceptCookie;
