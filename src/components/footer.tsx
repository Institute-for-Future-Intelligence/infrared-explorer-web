import { Link } from 'react-router-dom';
import { useIsPhone } from '../hooks/useIsMobile';
import ifiLogo from '../assets/ifi-logo.png';

/** Page footer: IFI brand mark, copyright, and a Contact-us link (telelab parity). The app version and
    build time live in the sidebar footer (bottom-left) instead. */
const Footer = () => {
  const isPhone = useIsPhone();
  return (
    <div
      style={{
        marginTop: 24,
        padding: '16px 8px',
        textAlign: 'center',
        fontSize: isPhone ? 11 : 12,
        color: 'var(--ifi-text-tertiary)',
        // On a phone, stack and centre so the links/copyright don't wrap awkwardly mid-line.
        ...(isPhone ? { display: 'flex', flexDirection: 'column' as const, alignItems: 'center' } : null),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', columnGap: 6, flexWrap: 'wrap' }}>
        {/* The full logo is a 700x210 symbol+wordmark lockup; a square box with object-fit:cover and a
            left origin crops it to just the tree symbol (same trick as the collapsed sidebar rail),
            since the wordmark would duplicate the copyright text right next to it. */}
        <a
          href="https://intofuture.org"
          target="_blank"
          rel="noopener noreferrer"
          title="Go to Institute for Future Intelligence"
          style={{ display: 'inline-flex' }}
        >
          <img
            src={ifiLogo}
            alt="Institute for Future Intelligence"
            style={{ width: 18, height: 18, objectFit: 'cover', objectPosition: 'left center' }}
          />
        </a>
        <span>
          © {new Date().getFullYear()} Institute for Future Intelligence, Inc. All Rights Reserved. ·{' '}
          <Link to="/contact">Contact us</Link> · <Link to="/about">About</Link>
        </span>
      </div>
    </div>
  );
};

export default Footer;
