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
  const margin = '2px';
  const size = 20;
  const iconStyle = { paddingRight: margin };

  const location = useLocation();
  const url = HOME_URL + '#' + location.pathname;

  return (
    <div>
      <FacebookShareButton url={url} title={title} style={iconStyle}>
        <FacebookIcon size={size} round />
      </FacebookShareButton>
      <LineShareButton url={url} title={title} style={iconStyle}>
        <LineIcon size={size} round />
      </LineShareButton>
      <LinkedinShareButton url={url} title={title} style={iconStyle}>
        <LinkedinIcon size={size} round />
      </LinkedinShareButton>
      <RedditShareButton url={url} title={title} style={iconStyle}>
        <RedditIcon size={size} round />
      </RedditShareButton>
      <TumblrShareButton url={url} title={title} style={iconStyle}>
        <TumblrIcon size={size} round />
      </TumblrShareButton>
      <TwitterShareButton url={url} title={title} style={iconStyle}>
        <TwitterIcon size={size} round />
      </TwitterShareButton>
      <WhatsappShareButton url={url} title={title}>
        <WhatsappIcon size={size} round />
      </WhatsappShareButton>
    </div>
  );
};

export default ShareLinks;
