import { type ReactNode } from 'react';

interface Props {
  /** Illustration (an SVG); defaults to the iron-pseudocolour "heat handprint". */
  image?: ReactNode;
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}

/** The iron-colormap "heat handprint" — an infrared thumbprint left on a cold surface. Used as the
 *  default empty illustration so the emptiest page becomes a small brand moment. */
export const HeatHandprint = () => (
  <svg width="96" height="82" viewBox="0 0 96 82" role="img" aria-label="A fading infrared handprint">
    <defs>
      <radialGradient id="ifi-handprint" cx="0.5" cy="0.62" r="0.75">
        <stop offset="0" stopColor="#fde68a" />
        <stop offset="0.35" stopColor="#f08c1e" />
        <stop offset="0.62" stopColor="#c73e2e" />
        <stop offset="0.85" stopColor="#8b1e5f" />
        <stop offset="1" stopColor="#3d0f63" />
      </radialGradient>
      <filter id="ifi-handprint-soft">
        <feGaussianBlur stdDeviation="2.4" />
      </filter>
    </defs>
    <g fill="url(#ifi-handprint)" filter="url(#ifi-handprint-soft)">
      <ellipse cx="48" cy="55" rx="19" ry="17" />
      <ellipse cx="27" cy="34" rx="5.5" ry="13" transform="rotate(-18 27 34)" />
      <ellipse cx="40" cy="26" rx="5.5" ry="16" />
      <ellipse cx="53" cy="24" rx="5.5" ry="17" />
      <ellipse cx="64" cy="30" rx="5.5" ry="14" transform="rotate(10 64 30)" />
      <ellipse cx="75" cy="48" rx="5" ry="10" transform="rotate(38 75 48)" />
    </g>
  </svg>
);

/** Centered empty / error placeholder: an illustration over a title, an optional hint, and an
 *  optional primary action. Shared by the home empty grid, Trash, and the 404 page so they read as
 *  one family ("No heat signatures found" / "All cool here" / "This spot has gone cold"). */
const EmptyState = ({ image, title, hint, action }: Props) => (
  <div className="empty-state">
    <div className="empty-state-art">{image ?? <HeatHandprint />}</div>
    <h3 className="empty-state-title">{title}</h3>
    {hint && <p className="empty-state-hint">{hint}</p>}
    {action && (
      <button type="button" className="empty-state-action" onClick={action.onClick}>
        {action.label}
      </button>
    )}
  </div>
);

export default EmptyState;
