import React from 'react';
import AccountSection from './accountSection.tsx';
import Title from './title.tsx';
import goBackArrow from '../../assets/left-arrow.svg';
import ifiLogo from '../../assets/ifi-logo.png';
import { useLocation, useNavigate } from 'react-router-dom';

const Header = React.memo(() => {
  const location = useLocation();
  const navagate = useNavigate();
  const isHome = location.pathname === '/';
  return (
    <header className="header">
      {/* Parent-org brand, top-left. Shown on the home page only, where the back arrow (which
          occupies the same left slot on inner pages) is absent. */}
      {isHome && (
        <img
          className="ifi-logo"
          src={ifiLogo}
          alt="Institute for Future Intelligence"
          title="Go to Institute for Future Intelligence"
          onClick={() => window.open('https://intofuture.org', '_blank')}
        />
      )}
      {!isHome && <img className="goback-arrow" src={goBackArrow} onClick={() => navagate(-1)} />}
      <Title />
      <AccountSection />
    </header>
  );
});

export default Header;
