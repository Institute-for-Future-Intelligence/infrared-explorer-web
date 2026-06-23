import { Link } from 'react-router-dom';
import { VERSION } from '../utils/constants';

/** Page footer: version, copyright, and a Contact-us link (telelab parity). */
const Footer = () => (
  <div
    style={{
      marginTop: 24,
      padding: '16px 8px',
      textAlign: 'center',
      fontSize: 12,
      color: 'var(--ifi-grey)',
    }}
  >
    <div>Infrared Explorer v{VERSION}</div>
    <div>
      © {new Date().getFullYear()} Institute for Future Intelligence, Inc. All Rights Reserved. ·{' '}
      <Link to="/contact">Contact us</Link> · <Link to="/about">About</Link>
    </div>
  </div>
);

export default Footer;
