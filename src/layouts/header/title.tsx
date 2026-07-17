import { useNavigate } from 'react-router-dom';

/** Brand mark: a viewfinder frame (four corner brackets, stroked in the heat spectrum) around a hot
 *  point source — "an instrument framing a heat source". Inline SVG so it stays crisp and themeable,
 *  replacing the raster lab-logo.png. */
const Logo = () => (
  <svg className="brand-logo" width="30" height="30" viewBox="0 0 30 30" aria-hidden focusable="false">
    <defs>
      <linearGradient id="ifi-brand-spectrum" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#3d0f63" />
        <stop offset="0.4" stopColor="#8b1e5f" />
        <stop offset="0.7" stopColor="#c73e2e" />
        <stop offset="1" stopColor="#f08c1e" />
      </linearGradient>
      <radialGradient id="ifi-brand-hot" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#fde68a" />
        <stop offset="0.6" stopColor="#f08c1e" />
        <stop offset="1" stopColor="#c73e2e" />
      </radialGradient>
    </defs>
    <g stroke="url(#ifi-brand-spectrum)" strokeWidth="2.4" fill="none" strokeLinecap="round">
      <path d="M3 10 V5 a2 2 0 0 1 2-2 h5" />
      <path d="M20 3 h5 a2 2 0 0 1 2 2 v5" />
      <path d="M27 20 v5 a2 2 0 0 1-2 2 h-5" />
      <path d="M10 27 H5 a2 2 0 0 1-2-2 v-5" />
    </g>
    <circle cx="15" cy="15" r="5.2" fill="url(#ifi-brand-hot)" />
  </svg>
);

const Title = () => {
  const navigate = useNavigate();

  return (
    <div className="title" onClick={() => navigate('')}>
      <Logo />
      <h2>Infrared Explorer</h2>
    </div>
  );
};

export default Title;
