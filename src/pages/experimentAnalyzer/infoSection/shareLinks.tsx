import { useLocation } from 'react-router-dom';
import {
  FacebookIcon,
  FacebookShareButton,
  LineIcon,
  LineShareButton,
  LinkedinIcon,
  LinkedinShareButton,
  RedditIcon,
  RedditShareButton,
  TumblrIcon,
  TumblrShareButton,
  TwitterIcon,
  TwitterShareButton,
  WhatsappIcon,
  WhatsappShareButton,
} from 'react-share';
import { HOME_URL } from '../../../utils/constants';

export interface ShareLinkProps {
  /** Text the target network pre-fills as the post body. Defaults to the site name so the
   *  component is usable site-wide (e.g. the footer), not just on an experiment page. */
  title?: string;
}

const ShareLinks = ({ title = 'Infrared Explorer' }: ShareLinkProps) => {
  const size = 20;
  // Padding (not a bigger glyph) keeps each icon's hit area at 24px — the WCAG 2.5.8 minimum — while
  // staying compact enough to share one row with the rating stars; the negative row margin lets the
  // outer icons sit flush with the container edges despite that padding.
  const buttonStyle = { display: 'inline-flex', padding: 2, lineHeight: 0 };
  const rowStyle = { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 2, margin: '0 -2px' };

  const location = useLocation();
  const url = HOME_URL + '#' + location.pathname;

  return (
    <div style={rowStyle}>
      <FacebookShareButton url={url} title={title} style={buttonStyle} aria-label="Share on Facebook">
        <FacebookIcon size={size} round />
      </FacebookShareButton>
      <LineShareButton url={url} title={title} style={buttonStyle} aria-label="Share on LINE">
        <LineIcon size={size} round />
      </LineShareButton>
      <LinkedinShareButton url={url} title={title} style={buttonStyle} aria-label="Share on LinkedIn">
        <LinkedinIcon size={size} round />
      </LinkedinShareButton>
      <RedditShareButton url={url} title={title} style={buttonStyle} aria-label="Share on Reddit">
        <RedditIcon size={size} round />
      </RedditShareButton>
      <TumblrShareButton url={url} title={title} style={buttonStyle} aria-label="Share on Tumblr">
        <TumblrIcon size={size} round />
      </TumblrShareButton>
      <TwitterShareButton url={url} title={title} style={buttonStyle} aria-label="Share on X (Twitter)">
        <TwitterIcon size={size} round />
      </TwitterShareButton>
      <WhatsappShareButton url={url} title={title} style={buttonStyle} aria-label="Share on WhatsApp">
        <WhatsappIcon size={size} round />
      </WhatsappShareButton>
    </div>
  );
};

export default ShareLinks;
