import { Link } from 'react-router-dom';
import { VERSION } from '../utils/constants';
import { useIsPhone } from '../hooks/useIsMobile';

/** Page footer: version, copyright, and a Contact-us link (telelab parity). */
const Footer = () => {
  const isPhone = useIsPhone();
  return (
    <div
      style={{
        marginTop: 24,
        padding: '16px 8px',
        textAlign: 'center',
        fontSize: isPhone ? 11 : 12,
        color: 'var(--ifi-grey)',
        // On a phone, stack and centre so the links/copyright don't wrap awkwardly mid-line.
        ...(isPhone ? { display: 'flex', flexDirection: 'column' as const, alignItems: 'center' } : null),
      }}
    >
      <div>Infrared Explorer v{VERSION}</div>
      <div>
        © {new Date().getFullYear()} Institute for Future Intelligence, Inc. All Rights Reserved. ·{' '}
        <Link to="/contact">Contact us</Link> · <Link to="/about">About</Link>
      </div>
    </div>
  );
};

export default Footer;
