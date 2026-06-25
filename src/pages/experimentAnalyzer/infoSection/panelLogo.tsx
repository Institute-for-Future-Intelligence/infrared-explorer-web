import { Link } from 'react-router-dom';
import IfiLogo from '../../../assets/ifi-logo.png';
import { VERSION } from '../../../utils/constants';

/** IFI brand logo shown below the experiment info panel (telelab parity). */
const PanelLogo = () => (
  <div className="info-panel-logo">
    <img
      src={IfiLogo}
      alt="Institute for Future Intelligence"
      title="Go to Institute for Future Intelligence"
      onClick={() => window.open('https://intofuture.org', '_blank')}
    />
    <div className="info-panel-logo-sub">
      Powered by <Link to="/">Infrared Explorer v{VERSION}</Link> &nbsp;|&nbsp; <Link to="/about">About</Link>
    </div>
  </div>
);

export default PanelLogo;
